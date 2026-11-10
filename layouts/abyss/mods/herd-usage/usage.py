#!/usr/bin/env python3
"""herd-usage collector: token usage of every agent CLI on this machine.

Reads each CLI's own local records (nothing is sent anywhere, no network)
and prints one JSON document on stdout. Python 3.8+, standard library only.

  usage.py [--days N] [--home DIR]

Sources (all read-only):
  claude    ~/.claude/projects/**/*.jsonl            per assistant message
  codex     ~/.codex/sessions/**/rollout-*.jsonl[.zst]  cumulative token_count
  opencode  ~/.local/share/opencode/opencode.db      message.data
  devin     ~/.local/share/devin/{cli,cli-next}/sessions.db  message metrics
  goose     ~/.local/share/goose/sessions/sessions.db  usage_ledger / sessions
  amp       ~/.local/share/amp/threads/*.json        usageLedger.events

Token fields are reported as each CLI records them:
  in           input tokens that were not served from cache
  out          output tokens (reasoning included)
  cache_read   input tokens served from the prompt cache
  cache_write  input tokens written to the prompt cache
  cost         US dollars, only where the CLI records a dollar cost
  credits      the CLI's own credits (amp), never mixed into cost
Days are local calendar days; the window is the last N of them, today included.
"""
import argparse
import datetime as dt
import glob
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import time

FIELDS = ("in", "out", "cache_read", "cache_write", "cost", "credits", "msgs")


def bucket():
    return {k: 0 for k in FIELDS}


def num(v):
    """A non-negative number from whatever the source stored."""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return 0
    if f != f or f < 0:
        return 0
    return int(f) if f == int(f) else f


def iso_ts(s):
    """Seconds since the epoch from an ISO-8601 string, or None."""
    if not isinstance(s, str) or not s:
        return None
    try:
        t = s.strip().replace("Z", "+00:00")
        # Python 3.8-3.10 only accept 0, 3 or 6 fractional digits.
        if "." in t:
            head, rest = t.split(".", 1)
            i = 0
            while i < len(rest) and rest[i].isdigit():
                i += 1
            t = head + "." + (rest[:i] + "000000")[:6] + rest[i:]
        d = dt.datetime.fromisoformat(t)
        if d.tzinfo is None:
            d = d.replace(tzinfo=dt.timezone.utc)
        return d.timestamp()
    except ValueError:
        return None


def epoch(v):
    """Seconds from a value stored as seconds or milliseconds."""
    f = num(v)
    if not f:
        return None
    return f / 1000.0 if f > 1e11 else float(f)


class Agent:
    def __init__(self, key, name, window):
        self.key, self.name, self.window = key, name, window
        self.available = False
        self.error = None
        self.note = None
        self.limits = None
        self.last = None
        self.days = {d: bucket() for d in window.days}
        self.sessions = {d: set() for d in window.days}
        self.models = {}

    def add(self, ts, session=None, model=None, **tok):
        if ts is None:
            return
        day = dt.datetime.fromtimestamp(ts).date().isoformat()
        b = self.days.get(day)
        if b is None:
            return
        vals = {k: num(tok.get(k)) for k in FIELDS if k != "msgs"}
        if not any(vals.values()):
            return
        m = self.models.setdefault(str(model or "unknown"), bucket())
        for k, v in vals.items():
            b[k] += v
            m[k] += v
        b["msgs"] += 1
        m["msgs"] += 1
        if session is not None:
            self.sessions[day].add(str(session))
        if self.last is None or ts > self.last:
            self.last = ts

    def period(self, days):
        out, seen = bucket(), set()
        for d in days:
            for k in FIELDS:
                out[k] += self.days[d][k]
            seen |= self.sessions[d]
        out["cost"] = round(out["cost"], 6)
        out["credits"] = round(out["credits"], 6)
        out["sessions"] = len(seen)
        return out

    def report(self):
        w = self.window
        models = sorted(self.models.items(), key=lambda kv: -(kv[1]["in"] + kv[1]["out"]))[:8]
        return {
            "key": self.key,
            "name": self.name,
            "available": self.available,
            "error": self.error,
            "note": self.note,
            "today": self.period(w.days[-1:]),
            "d7": self.period(w.days[-7:]),
            "window": self.period(w.days),
            "daily": [dict(self.days[d], date=d, cost=round(self.days[d]["cost"], 6),
                           credits=round(self.days[d]["credits"], 6)) for d in w.days],
            "models": [dict(v, model=k, cost=round(v["cost"], 6), credits=round(v["credits"], 6))
                       for k, v in models],
            "limits": self.limits,
            "last_activity": int(self.last * 1000) if self.last else None,
        }


class Window:
    def __init__(self, n):
        today = dt.date.today()
        self.days = [(today - dt.timedelta(days=i)).isoformat() for i in range(n - 1, -1, -1)]
        first = today - dt.timedelta(days=n - 1)
        self.start = time.mktime(first.timetuple())  # local midnight, seconds


def recent(paths, window):
    """Files touched since the window began (older ones cannot hold events in it)."""
    out = []
    for p in paths:
        try:
            if os.path.getmtime(p) >= window.start:
                out.append(p)
        except OSError:
            pass
    return out


def connect(path):
    """A read-only connection; a database without its WAL opens as immutable."""
    last = None
    for mode in ("mode=ro", "immutable=1"):
        try:
            con = sqlite3.connect("file:%s?%s" % (path.replace("?", "%3f").replace("#", "%23"), mode),
                                  uri=True, timeout=2)
            con.execute("select count(*) from sqlite_master").fetchone()
            return con
        except sqlite3.Error as e:
            last = e
    raise last


def has_table(con, name):
    return con.execute("select 1 from sqlite_master where type='table' and name=?", (name,)).fetchone() is not None


# ---- Claude Code -----------------------------------------------------------

def claude(a, home):
    roots = [os.path.join(home, ".claude", "projects"), os.path.join(home, ".config", "claude", "projects")]
    env = os.environ.get("CLAUDE_CONFIG_DIR")
    if env:
        roots += [os.path.join(p, "projects") for p in env.split(",") if p]
    roots = [r for r in dict.fromkeys(roots) if os.path.isdir(r)]
    if not roots:
        return
    a.available = True
    seen = {}  # (message id, request id) -> event, the fullest copy wins
    anon = []
    for root in roots:
        for path in recent(glob.glob(os.path.join(root, "**", "*.jsonl"), recursive=True), a.window):
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                for line in f:
                    if '"usage"' not in line:
                        continue
                    try:
                        d = json.loads(line)
                    except ValueError:
                        continue
                    msg = d.get("message")
                    if not isinstance(msg, dict) or not isinstance(msg.get("usage"), dict):
                        continue
                    if msg.get("model") == "<synthetic>":
                        continue
                    u = msg["usage"]
                    ev = {
                        "ts": iso_ts(d.get("timestamp")),
                        "session": d.get("sessionId") or path,
                        "model": msg.get("model"),
                        "in": u.get("input_tokens"),
                        "out": u.get("output_tokens"),
                        "cache_read": u.get("cache_read_input_tokens"),
                        "cache_write": u.get("cache_creation_input_tokens"),
                    }
                    mid, rid = msg.get("id"), d.get("requestId")
                    if mid and rid:
                        old = seen.get((mid, rid))
                        if old is None or num(ev["out"]) > num(old["out"]):
                            seen[(mid, rid)] = ev
                    else:
                        anon.append(ev)
    for ev in list(seen.values()) + anon:
        a.add(ev.pop("ts"), ev.pop("session"), ev.pop("model"), **ev)


# ---- Codex -----------------------------------------------------------------

def codex_lines(path, a):
    if path.endswith(".zst"):
        exe = shutil.which("zstd")
        if not exe:
            a.note = "some sessions are zstd-compressed; install zstd to count them"
            return
        p = subprocess.Popen([exe, "-dcq", path], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        try:
            for raw in p.stdout:
                yield raw.decode("utf-8", "replace")
        finally:
            p.stdout.close()
            p.wait()
    else:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                yield line


def codex(a, home):
    roots = [os.path.join(home, ".codex", "sessions")]
    env = os.environ.get("CODEX_HOME")
    if env:
        roots.append(os.path.join(env, "sessions"))
    roots = [r for r in dict.fromkeys(roots) if os.path.isdir(r)]
    if not roots:
        return
    a.available = True
    limits_ts = None
    keys = ("input_tokens", "cached_input_tokens", "output_tokens", "cache_write_input_tokens")
    for root in roots:
        files = glob.glob(os.path.join(root, "**", "rollout-*.jsonl"), recursive=True)
        files += glob.glob(os.path.join(root, "**", "rollout-*.jsonl.zst"), recursive=True)
        for path in recent(files, a.window):
            model, prev = None, None
            for line in codex_lines(path, a):
                if '"turn_context"' not in line and '"token_count"' not in line:
                    continue
                try:
                    d = json.loads(line)
                except ValueError:
                    continue
                p = d.get("payload")
                if not isinstance(p, dict):
                    continue
                if d.get("type") == "turn_context":
                    model = p.get("model") or model
                    continue
                if p.get("type") != "token_count":
                    continue
                ts = iso_ts(d.get("timestamp"))
                rl = p.get("rate_limits")
                if isinstance(rl, dict) and isinstance(rl.get("primary"), dict) and ts and (limits_ts is None or ts > limits_ts):
                    limits_ts = ts
                    pr = rl["primary"]
                    a.limits = {
                        "used_percent": num(pr.get("used_percent")),
                        "window_minutes": num(pr.get("window_minutes")),
                        "resets_at": int(epoch(pr.get("resets_at")) * 1000) if epoch(pr.get("resets_at")) else None,
                        "plan": rl.get("plan_type"),
                        "as_of": int(ts * 1000),
                    }
                info = p.get("info")
                total = info.get("total_token_usage") if isinstance(info, dict) else None
                if not isinstance(total, dict):
                    continue
                cur = {k: num(total.get(k)) for k in keys}
                # Totals are cumulative per session: count what each event added.
                # A total that went down means the counter restarted.
                if prev is None or any(cur[k] < prev[k] for k in keys):
                    delta = cur
                else:
                    delta = {k: cur[k] - prev[k] for k in keys}
                prev = cur
                a.add(ts, path, model,
                      **{"in": max(0, delta["input_tokens"] - delta["cached_input_tokens"]),
                         "out": delta["output_tokens"],
                         "cache_read": delta["cached_input_tokens"],
                         "cache_write": delta["cache_write_input_tokens"]})


# ---- OpenCode --------------------------------------------------------------

def opencode(a, home):
    data = os.environ.get("XDG_DATA_HOME") or os.path.join(home, ".local", "share")
    path = os.path.join(data, "opencode", "opencode.db")
    if not os.path.isfile(path):
        return
    a.available = True
    con = connect(path)
    try:
        if not has_table(con, "message"):
            a.note = "this OpenCode version keeps no message table"
            return
        rows = con.execute("select session_id, time_created, data from message where time_created >= ?",
                           (int(a.window.start * 1000),))
        for session, created, raw in rows:
            try:
                d = json.loads(raw)
            except (TypeError, ValueError):
                continue
            if d.get("role") != "assistant" or not isinstance(d.get("tokens"), dict):
                continue
            t = d["tokens"]
            cache = t.get("cache") if isinstance(t.get("cache"), dict) else {}
            when = d.get("time") if isinstance(d.get("time"), dict) else {}
            model = d.get("modelID")
            if model and d.get("providerID"):
                model = "%s/%s" % (d["providerID"], model)
            a.add(epoch(when.get("created")) or epoch(created), session, model,
                  **{"in": t.get("input"),
                     "out": num(t.get("output")) + num(t.get("reasoning")),
                     "cache_read": cache.get("read"),
                     "cache_write": cache.get("write"),
                     "cost": d.get("cost")})
    finally:
        con.close()


# ---- Devin CLI -------------------------------------------------------------

def devin(a, home):
    data = os.environ.get("XDG_DATA_HOME") or os.path.join(home, ".local", "share")
    paths = [os.path.join(data, "devin", sub, "sessions.db") for sub in ("cli", "cli-next")]
    paths = [p for p in paths if os.path.isfile(p)]
    if not paths:
        return
    a.available = True
    seen = set()
    for path in paths:
        con = connect(path)
        try:
            if not has_table(con, "message_nodes"):
                continue
            # A message is copied into new nodes when its conversation forks or
            # is compacted: the copies keep its request id and its own
            # created_at, and only their row time is later. Count a request
            # once, on the day it was generated.
            rows = con.execute(
                "select session_id, created_at,"
                " json_extract(chat_message, '$.metadata.request_id'),"
                " json_extract(chat_message, '$.metadata.generation_model'),"
                " json_extract(chat_message, '$.metadata.metrics'),"
                " json_extract(chat_message, '$.metadata.created_at')"
                " from message_nodes"
                " where created_at >= ? and json_valid(chat_message)"
                " and json_extract(chat_message, '$.role') = 'assistant'",
                (int(a.window.start),))
            for session, created, request, model, metrics, generated in rows:
                if not metrics:
                    continue
                if request:
                    if request in seen:
                        continue
                    seen.add(request)
                try:
                    m = json.loads(metrics)
                except (TypeError, ValueError):
                    continue
                if not isinstance(m, dict):
                    continue
                a.add(iso_ts(generated) or epoch(created), session, model,
                      **{"in": m.get("input_tokens"),
                         "out": m.get("output_tokens"),
                         "cache_read": m.get("cache_read_tokens"),
                         "cache_write": m.get("cache_creation_tokens")})
        finally:
            con.close()


# ---- Goose -----------------------------------------------------------------

def goose(a, home):
    data = os.environ.get("XDG_DATA_HOME") or os.path.join(home, ".local", "share")
    path = os.path.join(data, "goose", "sessions", "sessions.db")
    if not os.path.isfile(path):
        return
    a.available = True
    con = connect(path)
    try:
        ledgered = set()
        if has_table(con, "usage_ledger"):
            for session, ts, model, i, o, cr, cw, cost in con.execute(
                    "select session_id, created_timestamp, model, input_tokens, output_tokens,"
                    " cache_read_tokens, cache_write_tokens, cost from usage_ledger"):
                ledgered.add(session)
                a.add(epoch(ts), session, model,
                      **{"in": i, "out": o, "cache_read": cr, "cache_write": cw, "cost": cost})
        if not has_table(con, "sessions"):
            return
        cols = {r[1] for r in con.execute("pragma table_info(sessions)")}
        want = ["id", "updated_at", "accumulated_input_tokens", "accumulated_output_tokens"]
        if not all(c in cols for c in want):
            return
        opt = ["accumulated_cache_read_tokens", "accumulated_cache_write_tokens", "accumulated_cost", "model_config_json"]
        sel = want + [c if c in cols else "null" for c in opt]
        # Sessions older than the ledger only keep their running totals: count
        # those once, on the day the session was last used.
        for sid, updated, i, o, cr, cw, cost, cfg in con.execute("select %s from sessions" % ", ".join(sel)):
            if sid in ledgered:
                continue
            model = None
            try:
                model = (json.loads(cfg) or {}).get("model_name") if cfg else None
            except (TypeError, ValueError):
                pass
            ts = iso_ts(str(updated).replace(" ", "T") + "+00:00") if updated and "+" not in str(updated) and "Z" not in str(updated) else iso_ts(str(updated))
            a.add(ts, sid, model, **{"in": i, "out": o, "cache_read": cr, "cache_write": cw, "cost": cost})
    finally:
        con.close()


# ---- Amp -------------------------------------------------------------------

def amp(a, home):
    data = os.environ.get("XDG_DATA_HOME") or os.path.join(home, ".local", "share")
    root = os.path.join(data, "amp", "threads")
    if not os.path.isdir(root):
        return
    a.available = True
    for path in recent(glob.glob(os.path.join(root, "*.json")), a.window):
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                d = json.load(f)
        except (OSError, ValueError):
            continue
        if not isinstance(d, dict):
            continue
        sid = d.get("id") or path
        ledger = d.get("usageLedger")
        events = ledger.get("events") if isinstance(ledger, dict) else None
        if isinstance(events, list) and events:
            for e in events:
                if not isinstance(e, dict):
                    continue
                t = e.get("tokens") if isinstance(e.get("tokens"), dict) else {}
                a.add(iso_ts(e.get("timestamp")), sid, e.get("model"),
                      **{"in": t.get("input"), "out": t.get("output"), "credits": e.get("credits")})
            continue
        # Threads from before the ledger: per-message usage, dated by the thread.
        ts = epoch(d.get("created"))
        for m in d.get("messages") or []:
            u = m.get("usage") if isinstance(m, dict) else None
            if not isinstance(u, dict):
                continue
            a.add(ts, sid, u.get("model"),
                  **{"in": u.get("inputTokens"), "out": u.get("outputTokens"),
                     "cache_read": u.get("cacheReadInputTokens"),
                     "cache_write": u.get("cacheCreationInputTokens"),
                     "credits": u.get("credits")})


SOURCES = [
    ("claude", "Claude Code", claude),
    ("codex", "Codex", codex),
    ("opencode", "OpenCode", opencode),
    ("devin", "Devin", devin),
    ("goose", "Goose", goose),
    ("amp", "Amp", amp),
]


def main():
    ap = argparse.ArgumentParser(description="Token usage of every agent CLI on this machine, as JSON.")
    ap.add_argument("--days", type=int, default=30, help="window in local calendar days, today included (1-365)")
    ap.add_argument("--home", default=os.path.expanduser("~"), help="home directory to read (for tests)")
    args = ap.parse_args()
    window = Window(max(1, min(365, args.days)))
    agents = []
    for key, name, fn in SOURCES:
        a = Agent(key, name, window)
        try:
            fn(a, args.home)
        except Exception as e:  # one unreadable source must not hide the others
            a.error = "%s: %s" % (type(e).__name__, e)
        agents.append(a)

    def total(days):
        out, sessions = bucket(), 0
        for a in agents:
            p = a.period(days)
            for k in FIELDS:
                out[k] += p[k]
            sessions += p["sessions"]
        out["cost"] = round(out["cost"], 6)
        out["credits"] = round(out["credits"], 6)
        out["sessions"] = sessions
        return out

    doc = {
        "generated_at": int(time.time() * 1000),
        "days": len(window.days),
        "from": window.days[0],
        "to": window.days[-1],
        "agents": [a.report() for a in agents],
        "totals": {
            "today": total(window.days[-1:]),
            "d7": total(window.days[-7:]),
            "window": total(window.days),
            "daily": [dict({k: sum(a.days[d][k] for a in agents) for k in FIELDS}, date=d) for d in window.days],
        },
    }
    for row in doc["totals"]["daily"]:
        row["cost"] = round(row["cost"], 6)
        row["credits"] = round(row["credits"], 6)
    json.dump(doc, sys.stdout, separators=(",", ":"))
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
