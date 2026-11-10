#!/usr/bin/env python3
"""crew.py - herd-bots team rooms over herdr-core.

Rooms are jsonl logs under the state dir; membership is terminal labels
(herd.bot=<id>, herd.room.<room>=1); delivery is `hc send`.
Stdlib only, python3 >= 3.8.
"""
import json
import os
import re
import subprocess
import sys
import time

ROOM_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,23}$")
MENTION_RE = re.compile(r"(?<![\w@])@([a-z0-9][a-z0-9_-]*)", re.IGNORECASE)
BROADCAST = {"all", "room", "everyone"}
MAX_TEXT = 4000
RATE_WINDOW_MS = 60_000
RATE_MAX_BOT_DELIVERED = 12


def state_dir():
    if os.environ.get("HERD_STATE"):
        return os.environ["HERD_STATE"]
    return os.path.join(os.environ.get("XDG_STATE_HOME", os.path.expanduser("~/.local/state")), "herd-bots")


def rooms_dir():
    return os.path.join(state_dir(), "rooms")


def makedirs_private(path):
    os.makedirs(path, exist_ok=True)
    try:
        os.chmod(path, 0o700)
    except OSError:
        pass


def room_path(room):
    return os.path.join(rooms_dir(), f"{room}.jsonl")


def hc(*args, check=False):
    r = subprocess.run([os.environ.get("HERD_HC", "hc"), *args],
                       capture_output=True, text=True)
    if check and r.returncode != 0:
        raise SystemExit(f"hc {' '.join(args)} failed: {r.stderr.strip()}")
    return r


def hc_json(*args):
    r = hc(*args, "--json")
    if r.returncode != 0:
        return None
    try:
        return json.loads(r.stdout)
    except json.JSONDecodeError:
        return None


def valid_room_or_die(room):
    if not ROOM_RE.match(room):
        print(f"invalid room name: {room}", file=sys.stderr)
        sys.exit(2)


def read_log(room, last=None):
    path = room_path(room)
    lines = []
    try:
        with open(path, "r", encoding="utf-8") as f:
            for raw in f:
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    lines.append(json.loads(raw))
                except json.JSONDecodeError:
                    continue  # tolerate a partial last line
    except FileNotFoundError:
        pass
    return lines[-last:] if last is not None else lines


def append_log(room, obj):
    makedirs_private(state_dir())
    makedirs_private(rooms_dir())
    path = room_path(room)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    with os.fdopen(fd, "a", encoding="utf-8") as f:
        f.write(json.dumps(obj, ensure_ascii=False) + "\n")


def members(room):
    """Live room members: [{terminal, bot}] from labels."""
    out = hc_json("ls", "--label", f"herd.room.{room}=1")
    terms = (out or {}).get("terminals") or []
    result = []
    for t in terms:
        addr = t.get("address")
        if not addr:
            continue
        info = hc_json("get", addr) or {}
        bot = (info.get("labels") or {}).get("herd.bot")
        result.append({"terminal": addr, "bot": bot})
    return result


def sender_bot(addr):
    info = hc_json("get", addr) or {}
    return (info.get("labels") or {}).get("herd.bot")


def send_line(addr, text):
    r = hc("send", addr, text)
    if r.returncode == 0:
        return None
    kind = None
    try:
        kind = json.loads(r.stderr).get("error", {}).get("kind")
    except Exception:
        pass
    return kind or "send failed"


def out(obj, as_json, human):
    if as_json:
        print(json.dumps(obj, ensure_ascii=False))
    else:
        print(human)


def cmd_rooms(as_json):
    makedirs_private(state_dir())
    makedirs_private(rooms_dir())
    names = sorted(f[:-6] for f in os.listdir(rooms_dir()) if f.endswith(".jsonl"))
    out(names, as_json, "\n".join(names) if names else "no rooms")


def cmd_read(room, last, as_json):
    valid_room_or_die(room)
    lines = read_log(room, last)
    if as_json:
        print(json.dumps(lines, ensure_ascii=False))
        return
    for m in lines:
        ts = time.strftime("%H:%M", time.localtime(m.get("ts", 0) / 1000))
        print(f"{ts} {m.get('from', '?')}: {m.get('text', '')}")


def cmd_who(room, as_json):
    valid_room_or_die(room)
    mem = members(room)
    out(mem, as_json, "\n".join(f"{m['terminal']} {m['bot'] or '?'}" for m in mem) or "no members")


def resolve_tab(tab_id):
    """Resolve a herdr tab id (possibly machine/id) to a terminal address."""
    label = tab_id.split("/", 1)[1] if "/" in tab_id else tab_id
    deadline = time.time() + 6
    while True:
        out = hc_json("ls", "--label", f"herdr.tab={label}")
        terms = (out or {}).get("terminals") or []
        if terms:
            return terms[0].get("address")
        if time.time() >= deadline:
            return None
        time.sleep(0.3)


def cmd_join(room, bot, terminal, tab, as_json):
    valid_room_or_die(room)
    addr = terminal or (resolve_tab(tab) if tab else None)
    if not addr:
        print("no terminal found", file=sys.stderr)
        sys.exit(1)
    hc("label", addr, f"herd.bot={bot}", f"herd.room.{room}=1", check=True)
    out({"terminal": addr, "bot": bot, "room": room}, as_json, f"{addr} joined #{room} as {bot}")


def cmd_leave(room, terminal, as_json):
    valid_room_or_die(room)
    hc("label", terminal, f"herd.room.{room}=", check=True)
    out({"terminal": terminal, "room": room}, as_json, f"{terminal} left #{room}")


def cmd_post(room, text, from_name, as_json):
    valid_room_or_die(room)
    text = text.strip()
    if not text:
        print("empty text", file=sys.stderr)
        sys.exit(2)
    if len(text) > MAX_TEXT:
        print("text too long", file=sys.stderr)
        sys.exit(2)
    my_terminal = os.environ.get("HC_TERMINAL_ID")
    terminal_bot = sender_bot(my_terminal) if my_terminal else None
    if terminal_bot:
        from_name = terminal_bot
    from_name = from_name or "you"
    sender_is_bot = from_name != "you"

    mentioned = {m.lower() for m in MENTION_RE.findall(text)}
    broadcast = bool(mentioned & BROADCAST)
    mem = members(room)
    wanted_ids = ({m["bot"].lower() for m in mem if m.get("bot")}
                  if broadcast else {m for m in mentioned if m not in BROADCAST})
    targets = []
    missed = []
    seen_ids = set()
    for bid in sorted(wanted_ids):
        got = [m for m in mem if (m.get("bot") or "").lower() == bid]
        if not got:
            missed.append({"bot": bid, "reason": "not in room"})
            continue
        seen_ids.add(bid)
        targets.extend(m for m in got if m["terminal"] != my_terminal)

    # loop guard: hold a bot post when the room is already too chatty
    held = None
    if sender_is_bot:
        now = int(time.time() * 1000)
        recent_bot_deliveries = sum(
            1 for l in read_log(room)
            if l.get("from") != "you" and l.get("delivered")
            and now - l.get("ts", 0) < RATE_WINDOW_MS)
        if recent_bot_deliveries >= RATE_MAX_BOT_DELIVERED:
            held = "rate"

    delivered = []
    if not held:
        for m in targets:
            reason = send_line(m["terminal"], f"[#{room}] {from_name}: {text}")
            if reason is None:
                delivered.append({"bot": m["bot"], "terminal": m["terminal"]})
            else:
                missed.append({"bot": m["bot"], "reason": reason})

    line = {"id": f"{int(time.time() * 1000):x}{os.getpid():x}",
            "ts": int(time.time() * 1000), "room": room,
            "from": from_name, "text": text,
            "to": sorted(seen_ids if broadcast or seen_ids else wanted_ids), "delivered": delivered,
            "missed": missed, "held": held}
    append_log(room, line)
    if as_json:
        print(json.dumps(line, ensure_ascii=False))
    else:
        for d in delivered:
            print(f"-> {d['bot']} ({d['terminal']})")
        for m_ in missed:
            print(f"x {m_['bot']}: {m_['reason']}")
        if held:
            print("held: rate")


def main(argv):
    args = list(argv)
    as_json = "--json" in args
    args = [a for a in args if a != "--json"]
    if not args:
        print(__doc__, file=sys.stderr)
        return 2
    cmd, rest = args[0], args[1:]
    USAGE = {
        "rooms": "crew.py rooms [--json]",
        "read": "crew.py read <room> [--last N] [--json]",
        "who": "crew.py who <room> [--json]",
        "join": "crew.py join <room> --bot <id> (--terminal <addr> | --tab <id>) [--json]",
        "leave": "crew.py leave <room> --terminal <addr> [--json]",
        "post": "crew.py post <room> <text> [--from NAME] [--json]",
    }

    def opt(name, default=None):
        if name in rest:
            i = rest.index(name)
            v = rest[i + 1] if i + 1 < len(rest) else default
            del rest[i:i + 2]
            return v
        return default

    try:
        if cmd == "rooms":
            cmd_rooms(as_json)
        elif cmd == "read":
            if not rest:
                raise ValueError
            room = rest.pop(0)
            cmd_read(room, int(opt("--last", 20)), as_json)
        elif cmd == "who":
            cmd_who(rest[0], as_json)
        elif cmd == "join":
            if not rest:
                raise ValueError
            cmd_join(rest[0], opt("--bot"), opt("--terminal"), opt("--tab"), as_json)
        elif cmd == "leave":
            if not rest:
                raise ValueError
            cmd_leave(rest[0], opt("--terminal"), as_json)
        elif cmd == "post":
            if len(rest) < 2:
                raise ValueError
            room = rest.pop(0)
            text = rest.pop(0)
            cmd_post(room, text, opt("--from"), as_json)
        else:
            raise ValueError
    except (ValueError, IndexError):
        print(f"usage: {USAGE.get(cmd, 'crew.py <rooms|read|who|join|leave|post>')}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
