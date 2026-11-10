import test from "node:test";
import assert from "node:assert/strict";
import { launchArgv, mergeConfig, roomPrompt } from "../mods/herd-bots/lib.js";

test("launchArgv", () => {
  assert.deepEqual(launchArgv(["claude"], { model_flag: "--model" }, "opus"), ["claude", "--model", "opus"]);
  for (const m of ["", "  ", undefined]) {
    assert.deepEqual(launchArgv(["claude"], { model_flag: "--model" }, m), ["claude"]);
  }
  assert.deepEqual(launchArgv(["claude"], undefined, "opus"), ["claude"]);
  assert.deepEqual(launchArgv(["claude"], {}, "opus"), ["claude"]);
  const run = ["codex", "--no-daemon"];
  assert.deepEqual(launchArgv(run, { model_flag: "--model" }, "gpt"), ["codex", "--no-daemon", "--model", "gpt"]);
  assert.deepEqual(run, ["codex", "--no-daemon"], "input array not mutated");
});

const DEF = JSON.stringify({
  agents: {
    claude: { model_flag: "--model", models: ["opus", "sonnet"] },
    codex: { model_flag: "--model", models: [] },
  },
  rooms: ["general"],
  bots: [{ id: "lead" }],
});

test("mergeConfig", () => {
  let c = mergeConfig(DEF, null);
  assert.deepEqual(c.bots, [{ id: "lead" }]);
  assert.equal(c.agentCfg.claude.models.length, 2);
  assert.deepEqual(c.rooms, ["general"]);

  c = mergeConfig(DEF, JSON.stringify({ bots: [] }));
  assert.deepEqual(c.bots, [], "the person's empty list wins");

  c = mergeConfig(DEF, JSON.stringify({ agents: { claude: { model_flag: "-m" } }, rooms: ["ops"] }));
  assert.deepEqual(c.agentCfg.claude, { model_flag: "-m" }, "user key overlays");
  assert.deepEqual(c.agentCfg.codex, { model_flag: "--model", models: [] }, "default keys kept");
  assert.deepEqual(c.rooms, ["ops"]);

  assert.throws(() => mergeConfig(DEF, "{nope"));
});

test("roomPrompt", () => {
  const local = roomPrompt({ name: "Reviewer", id: "reviewer", room: "general", crew: "/x/crew.py", remote: false });
  assert.match(local, /python3 "\/x\/crew\.py" post general/);
  assert.match(local, /#general/);
  const remote = roomPrompt({ name: "Reviewer", id: "reviewer", room: "general", crew: "/x/crew.py", remote: true });
  assert.doesNotMatch(remote, /python3/);
  assert.doesNotMatch(remote, /crew\.py/);
});
