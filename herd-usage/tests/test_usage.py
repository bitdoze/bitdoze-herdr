"""Regression tests for usage.py against a fake home with one small, known
record set per CLI. Every expected number below is worked out by hand from
the fixture, so a change in how a source is read shows up as a failed sum.
"""
import datetime as dt
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "..", "mods", "herd-usage", "usage.py")

NOW = time.time()
DAY = 86400


def noon(days_ago):
    """Local noon `days_ago` days back, as epoch seconds (safely inside that day)."""
    d = dt.date.today() - dt.timedelta(days=days_ago)
    return time.mktime(dt.datetime.combine(d, dt.time(12, 0)).timetuple())


def iso(ts):
    return dt.datetime.fromtimestamp(ts, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def day(days_ago):
    return (dt.date.today() - dt.timedelta(days=days_ago)).isoformat()


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def jsonl(path, rows):
    write(path, "".join(json.dumps(r) + "\n" for r in rows))


class Fixture:
    def __init__(self, home):
        self.home = home

    def claude(self):
        def line(ts, mid, rid, i, o, cr, cw, model="sonnet-x", session="s1"):
            return {"type": "assistant", "timestamp": iso(ts), "sessionId": session, "requestId": rid,
                    "message": {"id": mid, "model": model,
                                "usage": {"input_tokens": i, "output_tokens": o,
                                          "cache_read_input_tokens": cr, "cache_creation_input_tokens": cw}}}
        jsonl(os.path.join(self.home, ".claude", "projects", "p1", "a.jsonl"), [
            line(noon(0), "m1", "r1", 100, 10, 1000, 50),
            # the same message logged again while streaming: fuller copy wins, counted once
            line(noon(0), "m1", "r1", 100, 40, 1000, 50),
            line(noon(2), "m2", "r2", 200, 20, 0, 0, session="s2"),
            line(noon(2), "m3", "r3", 5, 5, 0, 0, model="<synthetic>"),   # ignored
            line(noon(40), "m4", "r4", 999, 999, 0, 0),                  # before the window
            {"type": "user", "timestamp": iso(noon(0)), "message": {"role": "user", "content": "hi"}},
        ])

    def codex(self):
        def tc(ts, i, c, o, limits=None):
            p = {"type": "token_count",
                 "info": {"total_token_usage": {"input_tokens": i, "cached_input_tokens": c, "output_tokens": o}}}
            if limits:
                p["rate_limits"] = limits
            return {"timestamp": iso(ts), "type": "event_msg", "payload": p}
        lim = {"primary": {"used_percent": 7.5, "window_minutes": 300, "resets_at": int(NOW) + 3600}, "plan_type": "plus"}
        jsonl(os.path.join(self.home, ".codex", "sessions", "2026", "01", "01", "rollout-x.jsonl"), [
            {"timestamp": iso(noon(1)), "type": "turn_context", "payload": {"model": "gpt-x"}},
            tc(noon(1), 1000, 800, 50),            # +200 in, +800 cached, +50 out
            tc(noon(1) + 1, 1000, 800, 50),        # duplicate event: adds nothing
            tc(noon(1) + 2, 3000, 2500, 90),       # +300 in, +1700 cached, +40 out
            tc(noon(0), 500, 100, 10, lim),        # counter restarted: +400 in, +100 cached, +10 out
            {"timestamp": iso(noon(0)), "type": "event_msg", "payload": {"type": "token_count", "info": None}},
        ])

    def opencode(self):
        path = os.path.join(self.home, ".local", "share", "opencode", "opencode.db")
        os.makedirs(os.path.dirname(path))
        con = sqlite3.connect(path)
        con.execute("create table message (id text primary key, session_id text, time_created integer, time_updated integer, data text)")
        def msg(mid, ts, role, tokens=None, cost=0, session="o1"):
            d = {"role": role, "modelID": "m-oc", "providerID": "prov", "cost": cost, "time": {"created": int(ts * 1000)}}
            if tokens:
                d["tokens"] = tokens
            con.execute("insert into message values (?,?,?,?,?)", (mid, session, int(ts * 1000), int(ts * 1000), json.dumps(d)))
        msg("a", noon(0), "assistant", {"input": 10, "output": 20, "reasoning": 5, "cache": {"read": 300, "write": 7}}, 0.25)
        msg("b", noon(3), "assistant", {"input": 1, "output": 2, "reasoning": 0, "cache": {"read": 0, "write": 0}}, 0.5, "o2")
        msg("c", noon(0), "user")
        msg("d", noon(45), "assistant", {"input": 999, "output": 999, "reasoning": 0, "cache": {"read": 0, "write": 0}})
        con.commit()
        con.close()

    def devin(self):
        for sub, rows in (("cli", [
            # (session, row time, request id, generated at, in, out, cache read, cache write)
            ("d1", noon(0), "q1", noon(0), 2, 100, 5000, 30),
            ("d1", noon(0) + 60, "q1", noon(0), 2, 100, 5000, 30),     # fork copy of q1
            ("d1", noon(0) + 120, "q1", noon(0), 2, 100, 5000, 30),    # another copy
            ("d1", noon(0), "q0", noon(40), 9, 900, 0, 0),             # old message copied into a recent row
            ("d2", noon(5), "q2", noon(5), 4, 50, 0, 0),
        ]), ("cli-next", [
            ("d3", noon(1), "q3", noon(1), 1, 10, 100, 0),
            ("d3", noon(1), "q2", noon(5), 4, 50, 0, 0),               # same request in the other database
        ])):
            path = os.path.join(self.home, ".local", "share", "devin", sub, "sessions.db")
            os.makedirs(os.path.dirname(path))
            con = sqlite3.connect(path)
            con.execute("create table message_nodes (row_id integer primary key autoincrement, session_id text, node_id integer, parent_node_id integer, chat_message text, created_at integer, metadata text)")
            for n, (session, row_ts, rid, gen_ts, i, o, cr, cw) in enumerate(rows):
                cm = {"role": "assistant", "content": "x", "metadata": {
                    "request_id": rid, "generation_model": "dv-model", "created_at": iso(gen_ts),
                    "metrics": {"input_tokens": i, "output_tokens": o, "cache_read_tokens": cr, "cache_creation_tokens": cw}}}
                con.execute("insert into message_nodes (session_id, node_id, chat_message, created_at) values (?,?,?,?)",
                            (session, n, json.dumps(cm), int(row_ts)))
            con.execute("insert into message_nodes (session_id, node_id, chat_message, created_at) values (?,?,?,?)",
                        ("d1", 99, json.dumps({"role": "user", "content": "hi", "metadata": {}}), int(noon(0))))
            con.commit()
            con.close()

    def goose(self):
        path = os.path.join(self.home, ".local", "share", "goose", "sessions", "sessions.db")
        os.makedirs(os.path.dirname(path))
        con = sqlite3.connect(path)
        con.execute("create table sessions (id text primary key, updated_at timestamp, accumulated_input_tokens integer, accumulated_output_tokens integer, accumulated_cache_read_tokens integer, accumulated_cache_write_tokens integer, accumulated_cost real, model_config_json text)")
        con.execute("create table usage_ledger (id integer primary key autoincrement, session_id text, created_timestamp integer, model text, input_tokens integer, output_tokens integer, total_tokens integer, cache_read_tokens integer, cache_write_tokens integer, cost real)")
        utc = dt.datetime.fromtimestamp(noon(2), dt.timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
        # g1 has ledger rows: its running totals must not be counted again
        con.execute("insert into sessions values ('g1', ?, 9999, 9999, 0, 0, 9.0, null)", (utc,))
        con.execute("insert into sessions values ('g2', ?, 70, 30, 11, 0, 0.1, ?)", (utc, json.dumps({"model_name": "gm-old"})))
        con.execute("insert into usage_ledger (session_id, created_timestamp, model, input_tokens, output_tokens, total_tokens, cache_read_tokens, cache_write_tokens, cost) values ('g1', ?, 'gm', 500, 60, 560, 40, 0, 0.02)", (int(noon(0)),))
        con.execute("insert into usage_ledger (session_id, created_timestamp, model, input_tokens, output_tokens, total_tokens, cache_read_tokens, cache_write_tokens, cost) values ('g1', ?, 'gm', 100, 10, 110, 0, 0, 0.01)", (int(noon(1)),))
        con.commit()
        con.close()

    def amp(self):
        write(os.path.join(self.home, ".local", "share", "amp", "threads", "T-1.json"), json.dumps({
            "id": "T-1", "created": int(noon(0) * 1000), "messages": [],
            "usageLedger": {"events": [
                {"timestamp": iso(noon(0)), "model": "am", "credits": 0.5, "tokens": {"input": 30, "output": 3}},
                {"timestamp": iso(noon(6)), "model": "am", "credits": 1.25, "tokens": {"input": 70, "output": 7}},
            ]}}))
        # a thread from before the ledger: per-message usage, dated by the thread
        write(os.path.join(self.home, ".local", "share", "amp", "threads", "T-2.json"), json.dumps({
            "id": "T-2", "created": int(noon(1) * 1000),
            "messages": [{"role": "assistant", "usage": {"model": "am-old", "inputTokens": 8, "outputTokens": 2,
                                                         "cacheReadInputTokens": 20, "cacheCreationInputTokens": 4, "credits": 0.1}},
                         {"role": "user"}]}))


def run_usage(home, days=30):
    env = dict(os.environ, HOME=home)
    for k in ("XDG_DATA_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME"):
        env.pop(k, None)
    r = subprocess.run([sys.executable, SCRIPT, "--days", str(days), "--home", home],
                       capture_output=True, text=True, env=env)
    if r.returncode != 0:
        raise AssertionError(r.stderr)
    return json.loads(r.stdout)


def tok(p):
    return (p["in"], p["out"], p["cache_read"], p["cache_write"])


class UsageTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        fx = Fixture(cls.tmp.name)
        for name in ("claude", "codex", "opencode", "devin", "goose", "amp"):
            getattr(fx, name)()
        cls.doc = run_usage(cls.tmp.name)
        cls.by = {a["key"]: a for a in cls.doc["agents"]}

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_shape(self):
        d = self.doc
        self.assertEqual(d["days"], 30)
        self.assertEqual(d["to"], day(0))
        self.assertEqual(d["from"], day(29))
        self.assertEqual([a["key"] for a in d["agents"]], ["claude", "codex", "opencode", "devin", "goose", "amp"])
        for a in d["agents"]:
            self.assertTrue(a["available"], a["key"])
            self.assertIsNone(a["error"], a["key"])
            self.assertEqual(len(a["daily"]), 30)
            self.assertEqual(a["daily"][-1]["date"], day(0))

    def test_claude_dedupes_streamed_copies(self):
        a = self.by["claude"]
        self.assertEqual(tok(a["today"]), (100, 40, 1000, 50))
        self.assertEqual(a["today"]["msgs"], 1)
        self.assertEqual(tok(a["window"]), (300, 60, 1000, 50))
        self.assertEqual(a["window"]["sessions"], 2)
        self.assertEqual([m["model"] for m in a["models"]], ["sonnet-x"])

    def test_codex_counts_deltas_and_restart(self):
        a = self.by["codex"]
        self.assertEqual(tok(a["today"]), (400, 10, 100, 0))
        self.assertEqual(tok(a["window"]), (900, 100, 2600, 0))
        self.assertEqual(a["window"]["msgs"], 3)
        self.assertEqual(a["models"][0]["model"], "gpt-x")
        self.assertEqual(a["limits"]["used_percent"], 7.5)
        self.assertEqual(a["limits"]["window_minutes"], 300)
        self.assertEqual(a["limits"]["plan"], "plus")

    def test_opencode_adds_reasoning_to_output(self):
        a = self.by["opencode"]
        self.assertEqual(tok(a["today"]), (10, 25, 300, 7))
        self.assertEqual(tok(a["window"]), (11, 27, 300, 7))
        self.assertAlmostEqual(a["window"]["cost"], 0.75)
        self.assertEqual(a["models"][0]["model"], "prov/m-oc")

    def test_devin_counts_each_request_once_on_its_own_day(self):
        a = self.by["devin"]
        self.assertEqual(tok(a["today"]), (2, 100, 5000, 30))
        self.assertEqual(a["today"]["msgs"], 1)
        # q1 once, q2 once (it sits in both databases), q3; q0 was generated before the window
        self.assertEqual(tok(a["window"]), (7, 160, 5100, 30))
        self.assertEqual(a["window"]["msgs"], 3)
        self.assertEqual(a["window"]["sessions"], 3)

    def test_goose_ledger_wins_over_running_totals(self):
        a = self.by["goose"]
        self.assertEqual(tok(a["today"]), (500, 60, 40, 0))
        self.assertEqual(tok(a["window"]), (670, 100, 51, 0))
        self.assertAlmostEqual(a["window"]["cost"], 0.13)
        self.assertEqual(sorted(m["model"] for m in a["models"]), ["gm", "gm-old"])

    def test_amp_ledger_and_legacy_threads(self):
        a = self.by["amp"]
        self.assertEqual(tok(a["today"]), (30, 3, 0, 0))
        self.assertEqual(tok(a["window"]), (108, 12, 20, 4))
        self.assertAlmostEqual(a["window"]["credits"], 1.85)
        self.assertEqual(a["window"]["cost"], 0)

    def test_periods_and_totals_add_up(self):
        t = self.doc["totals"]
        for field in ("in", "out", "cache_read", "cache_write", "msgs"):
            self.assertEqual(t["window"][field], sum(a["window"][field] for a in self.doc["agents"]), field)
            self.assertEqual(t["window"][field], sum(row[field] for row in t["daily"]), field)
            self.assertEqual(t["today"][field], t["daily"][-1][field], field)
        # 7 days = today and the six before it: claude m2 (2 days ago) is in, devin q2 (5 days ago) is in,
        # amp's second event (6 days ago) is in
        self.assertEqual(tok(self.by["claude"]["d7"]), (300, 60, 1000, 50))
        self.assertEqual(tok(self.by["amp"]["d7"]), (108, 12, 20, 4))

    def test_short_window_drops_older_days(self):
        doc = run_usage(self.tmp.name, days=2)
        by = {a["key"]: a for a in doc["agents"]}
        self.assertEqual(doc["days"], 2)
        self.assertEqual(tok(by["claude"]["window"]), (100, 40, 1000, 50))   # m2 is 2 days ago: out
        self.assertEqual(tok(by["codex"]["window"]), (900, 100, 2600, 0))    # yesterday and today
        self.assertEqual(tok(by["goose"]["window"]), (600, 70, 40, 0))       # legacy session g2 is out

    def test_empty_home_reports_nothing_available(self):
        with tempfile.TemporaryDirectory() as empty:
            doc = run_usage(empty)
        self.assertTrue(all(not a["available"] and a["error"] is None for a in doc["agents"]))
        self.assertEqual(doc["totals"]["window"]["in"], 0)

    def test_broken_source_does_not_hide_the_others(self):
        with tempfile.TemporaryDirectory() as home:
            fx = Fixture(home)
            fx.claude()
            write(os.path.join(home, ".local", "share", "opencode", "opencode.db"), "this is not a database")
            doc = run_usage(home)
        by = {a["key"]: a for a in doc["agents"]}
        self.assertIsNotNone(by["opencode"]["error"])
        self.assertEqual(tok(by["claude"]["window"]), (300, 60, 1000, 50))


if __name__ == "__main__":
    unittest.main()
