import json
import os
import stat
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
CREW = os.path.join(HERE, "..", "mods", "herd-bots", "crew.py")

# Fake hc: answers from a fixture JSON; appends every argv to a log file.
FAKE_HC = """#!/usr/bin/env python3
import json, os, sys
fix = json.load(open(os.environ["FIXTURE"]))
args = sys.argv[1:]
prior = 0
if os.path.exists(os.environ["HC_LOG"]):
    for line in open(os.environ["HC_LOG"]):
        if line.strip() and json.loads(line) == args:
            prior += 1
with open(os.environ["HC_LOG"], "a") as f:
    f.write(json.dumps(args) + "\\n")
if args[0] == "ls":
    label = args[args.index("--label") + 1] if "--label" in args else None
    val = fix.get("ls", {}).get(label, [])
    if isinstance(val, dict):
        val = val["seq"][min(prior, len(val["seq"]) - 1)]
    print(json.dumps({"terminals": [{"address": a} for a in val]}))
elif args[0] == "get":
    print(json.dumps({"address": args[1], "labels": fix.get("get", {}).get(args[1], {})}))
elif args[0] == "label":
    sys.exit(0)
elif args[0] == "send":
    code = fix.get("send", {}).get(args[1], 0)
    if code:
        print(json.dumps({"error": {"kind": "blocked"}}), file=sys.stderr)
    sys.exit(code)
"""


class CrewTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.state = os.path.join(self.tmp.name, "state")
        self.hc_log = os.path.join(self.tmp.name, "hc.log")
        self.fixture_path = os.path.join(self.tmp.name, "fixture.json")
        self.hc = os.path.join(self.tmp.name, "hc")
        with open(self.hc, "w") as f:
            f.write(FAKE_HC)
        os.chmod(self.hc, os.stat(self.hc).st_mode | stat.S_IEXEC)
        self.fixture = {
            "ls": {"herd.room.general=1": ["t5", "t6"], "herdr.tab=tbX": []},
            "get": {"t5": {"herd.bot": "reviewer"}, "t6": {"herd.bot": "builder"}, "t9": {"herd.bot": "ship"}},
            "send": {},
        }
        self.write_fixture()

    def tearDown(self):
        self.tmp.cleanup()

    def write_fixture(self):
        with open(self.fixture_path, "w") as f:
            json.dump(self.fixture, f)

    def crew(self, *args, env=None):
        e = dict(os.environ)
        e.update({"HERD_STATE": self.state, "HERD_HC": self.hc,
                  "FIXTURE": self.fixture_path, "HC_LOG": self.hc_log})
        e.pop("HC_TERMINAL_ID", None)
        if env:
            e.update(env)
        return subprocess.run([sys.executable, CREW, *args],
                              capture_output=True, text=True, env=e)

    def calls(self):
        if not os.path.exists(self.hc_log):
            return []
        with open(self.hc_log) as f:
            return [json.loads(l) for l in f if l.strip()]

    def sends(self):
        return [c for c in self.calls() if c and c[0] == "send"]

    def log_lines(self, room="general"):
        path = os.path.join(self.state, "rooms", f"{room}.jsonl")
        if not os.path.exists(path):
            return []
        with open(path) as f:
            return [json.loads(l) for l in f if l.strip()]

    def post(self, *args, env=None):
        r = self.crew("post", *args, "--json", env=env)
        self.assertEqual(r.returncode, 0, r.stderr)
        return json.loads(r.stdout)

    def test_post_no_mention(self):
        line = self.post("general", "hello")
        self.assertEqual(line["to"], [])
        self.assertEqual(self.sends(), [])
        self.assertEqual(len(self.log_lines()), 1)

    def test_post_mention(self):
        line = self.post("general", "@reviewer hi")
        self.assertEqual(len(self.sends()), 1)
        self.assertEqual(self.sends()[0], ["send", "t5", "[#general] you: @reviewer hi"])
        self.assertEqual(line["delivered"], [{"bot": "reviewer", "terminal": "t5"}])

    def test_post_all_excludes_sender(self):
        line = self.post("general", "@all status?", env={"HC_TERMINAL_ID": "t6"})
        self.assertEqual(line["from"], "builder")
        self.assertEqual(len(self.sends()), 1)
        self.assertEqual(self.sends()[0][1], "t5")

    def test_post_absent_member(self):
        line = self.post("general", "@ship ready")
        self.assertEqual(self.sends(), [])
        self.assertEqual(line["missed"], [{"bot": "ship", "reason": "not in room"}])

    def test_send_failure_reason(self):
        self.fixture["send"]["t5"] = 9
        self.write_fixture()
        line = self.post("general", "@reviewer x")
        self.assertEqual(line["delivered"], [])
        self.assertEqual(line["missed"], [{"bot": "reviewer", "reason": "blocked"}])

    def test_loop_guard(self):
        now = int(time.time() * 1000)
        os.makedirs(os.path.join(self.state, "rooms"), exist_ok=True)
        with open(os.path.join(self.state, "rooms", "general.jsonl"), "w") as f:
            for i in range(12):
                f.write(json.dumps({"id": str(i), "ts": now - i * 100, "room": "general",
                                    "from": "builder", "text": "x", "to": ["reviewer"],
                                    "delivered": [{"bot": "reviewer", "terminal": "t5"}],
                                    "missed": [], "held": None}) + "\n")
        line = self.post("general", "@reviewer again", env={"HC_TERMINAL_ID": "t6"})
        self.assertEqual(line["held"], "rate")
        self.assertEqual(self.sends(), [])
        line = self.post("general", "@reviewer human")
        self.assertEqual(len(self.sends()), 1)

    def test_bad_room_and_empty_text(self):
        r = self.crew("post", "Bad Room", "hi")
        self.assertEqual(r.returncode, 2)
        self.assertFalse(os.path.exists(os.path.join(self.state, "rooms", "Bad Room.jsonl")))
        self.assertFalse(os.path.exists(os.path.join(self.state, "rooms", "bad room.jsonl")))
        r = self.crew("post", "general", "   ")
        self.assertEqual(r.returncode, 2)

    def test_read_last(self):
        for i in range(3):
            self.post("general", f"msg{i}")
        r = self.crew("read", "general", "--last", "2", "--json")
        lines = json.loads(r.stdout)
        self.assertEqual([m["text"] for m in lines], ["msg1", "msg2"])

    def test_mention_syntax(self):
        line = self.post("general", "mail a@b.com")
        self.assertEqual(line["to"], [])
        line = self.post("general", "@Reviewer hi")
        self.assertEqual(line["to"], ["reviewer"])

    def test_identity_beats_from(self):
        line = self.post("general", "@reviewer hi", env={"HC_TERMINAL_ID": "t6", })
        line = self.post("general", "@reviewer hi2", env={"HC_TERMINAL_ID": "t6"})
        self.assertEqual(line["from"], "builder")

    def test_identity_beats_from_flag(self):
        # --from is ignored when the terminal carries a herd.bot label
        e = {"HC_TERMINAL_ID": "t6"}
        r = self.crew("post", "general", "@reviewer hi", "--from", "you", "--json", env=e)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(r.stdout)["from"], "builder")

    def test_same_bot_two_terminals(self):
        self.fixture["ls"]["herd.room.general=1"] = ["t5", "t6", "t7"]
        self.fixture["get"]["t7"] = {"herd.bot": "reviewer"}
        self.write_fixture()
        line = self.post("general", "@reviewer hi")
        self.assertEqual(len(self.sends()), 2)
        self.assertEqual(sorted(s[1] for s in self.sends()), ["t5", "t7"])

    def test_usage_errors_exit_2(self):
        r = self.crew("post", "general")
        self.assertEqual(r.returncode, 2)
        self.assertIn("usage", r.stderr.lower())
        r = self.crew("read")
        self.assertEqual(r.returncode, 2)
        r = self.crew("frobnicate")
        self.assertEqual(r.returncode, 2)

    def test_join_retries_tab(self):
        self.fixture["ls"]["herdr.tab=tbX"] = {"seq": [[], [], ["t9"]]}
        self.write_fixture()
        r = self.crew("join", "general", "--bot", "ship", "--tab", "tbX", "--json")
        self.assertEqual(r.returncode, 0, r.stderr)
        labels = [c for c in self.calls() if c[0] == "label"]
        self.assertIn(["label", "t9", "herd.bot=ship", "herd.room.general=1"], labels)


if __name__ == "__main__":
    unittest.main()
