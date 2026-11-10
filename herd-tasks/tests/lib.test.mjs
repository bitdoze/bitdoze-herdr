import test from "node:test";
import assert from "node:assert/strict";
import { slugify, branchName, sectionOf, nextToStart, taskPrompt, reviewPrompt, launchArgv } from "../mods/herd-tasks/lib.js";

test("slugify", () => {
  assert.equal(slugify("Fix the Login bug!!"), "fix-the-login-bug");
  const long = slugify("a".repeat(100));
  assert.ok(long.length <= 40 && !long.endsWith("-"));
  assert.equal(slugify("🚀🚀"), "task");
});

test("branchName", () => {
  assert.equal(branchName("Fix login", []), "task/fix-login");
  assert.equal(branchName("Fix login", ["task/fix-login"]), "task/fix-login-2");
  assert.equal(branchName("Fix login", ["task/fix-login", "task/fix-login-2"]), "task/fix-login-3");
});

const now = 100000;
test("sectionOf", () => {
  assert.deepEqual(sectionOf({ state: "starting" }, null, now), { section: "working", closed: false });
  assert.equal(sectionOf({ state: "todo" }, null, now).section, "todo");
  assert.equal(sectionOf({ state: "queued" }, null, now).section, "queued");
  assert.equal(sectionOf({ state: "done" }, null, now).section, "done");
  assert.deepEqual(sectionOf({ state: "running" }, null, now), { section: "ready", closed: true });
  assert.equal(sectionOf({ state: "running" }, { status: "blocked" }, now).section, "needs");
  assert.equal(sectionOf({ state: "running" }, { status: "working" }, now).section, "working");
  assert.equal(sectionOf({ state: "running" }, { status: "done" }, now).section, "ready");
  assert.equal(sectionOf({ state: "running", started: now - 5000 }, { status: "idle" }, now).section, "working");
  assert.equal(sectionOf({ state: "running", started: now - 60000 }, { status: "idle" }, now).section, "ready");
});

test("nextToStart", () => {
  const mk = (state, created) => ({ state, created });
  const tasks = [mk("running", 1), mk("running", 2), mk("running", 3), mk("queued", 4), mk("queued", 5), mk("queued", 6)];
  assert.deepEqual(nextToStart(tasks, 4).map(t => t.created), [4]);
  assert.deepEqual(nextToStart(tasks, 2), []);
  const mix = [mk("running", 1), mk("running", 2), mk("starting", 3), mk("queued", 4), mk("queued", 5)];
  assert.deepEqual(nextToStart(mix, 4).map(t => t.created), [4]);
});

test("prompts", () => {
  const t = { title: "T", brief: "do it", path: "/w/x", branch: "task/t", repo: "/main", base: "main", worktree: true };
  const p = taskPrompt(t);
  for (const s of ["T", "do it", "/w/x", "task/t", "/main"]) assert.ok(p.includes(s), s);
  const empty = taskPrompt({ ...t, brief: "" });
  assert.ok(!empty.includes("\n\n\n"), "no blank double line");
  const plain = taskPrompt({ ...t, worktree: false });
  assert.ok(!plain.includes("worktree"));
  const r = reviewPrompt(t);
  assert.ok(r.includes("git diff main...HEAD"));
  assert.ok(r.includes('"VERDICT: ready to merge"'));
});

test("launchArgv", () => {
  assert.deepEqual(launchArgv(["claude"], { model_flag: "--model" }, "opus"), ["claude", "--model", "opus"]);
  assert.deepEqual(launchArgv(["claude"], { model_flag: "--model" }, ""), ["claude"]);
  assert.deepEqual(launchArgv(["claude"], undefined, "x"), ["claude"]);
});
