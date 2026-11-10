import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoOf, branches, start, stat, accept, discard } from "../mods/herd-tasks/git.js";

const haveGit = await new Promise(r => execFile("git", ["--version"], e => r(!e)));
if (!haveGit) {
  test("git tests skipped (no git)", () => console.log("SKIP git tests: git not found"));
} else {
  const run = (cmd, args, { cwd } = {}) => new Promise((res) => {
    execFile(cmd, args, { cwd: cwd ?? "/" }, (e, stdout, stderr) =>
      res({ code: e ? e.code ?? 1 : 0, stdout: String(stdout), stderr: String(stderr) }));
  });

  async function mkrepo() {
    const dir = mkdtempSync(join(tmpdir(), "ht-git-"));
    await run("git", ["init", "-b", "main"], { cwd: dir });
    await run("git", ["config", "user.email", "t@t"], { cwd: dir });
    await run("git", ["config", "user.name", "t"], { cwd: dir });
    writeFileSync(join(dir, "f.txt"), "one\n");
    await run("git", ["add", "."], { cwd: dir });
    await run("git", ["commit", "-m", "init"], { cwd: dir });
    return dir;
  }

  async function mkworktree(main) {
    const path = join(tmpdir(), `wt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const r = await start(run, { main, base: "main", branch: "task/x", path });
    assert.ok(r.ok, JSON.stringify(r));
    return { branch: "task/x", path };
  }

  test("start creates worktree + branch", async () => {
    const main = await mkrepo();
    const { branch, path } = await mkworktree(main);
    assert.ok(existsSync(path));
    assert.ok((await branches(run, main)).includes(branch));
  });

  test("accept happy path merges and cleans", async () => {
    const main = await mkrepo();
    const { branch, path } = await mkworktree(main);
    writeFileSync(join(path, "new.txt"), "hi\n");
    await run("git", ["add", "."], { cwd: path });
    await run("git", ["commit", "-m", "work"], { cwd: path });
    const r = await accept(run, { main, base: "main", branch, path });
    assert.deepEqual(r, { ok: true, merged: true });
    assert.ok(existsSync(join(main, "new.txt")));
    const parents = await run("git", ["-C", main, "rev-list", "--parents", "-n", "1", "HEAD"]);
    assert.equal(parents.stdout.trim().split(" ").length, 3, "merge commit");
    assert.ok(!existsSync(path));
    assert.ok(!(await branches(run, main)).includes(branch));
  });

  test("dirty worktree -> dirty-task", async () => {
    const main = await mkrepo();
    const { branch, path } = await mkworktree(main);
    writeFileSync(join(path, "uncommitted.txt"), "x\n");
    const head = (await run("git", ["-C", main, "rev-parse", "HEAD"])).stdout;
    const r = await accept(run, { main, base: "main", branch, path });
    assert.equal(r.code, "dirty-task");
    assert.equal((await run("git", ["-C", main, "rev-parse", "HEAD"])).stdout, head);
    assert.ok(existsSync(path));
  });

  test("no commits -> empty", async () => {
    const main = await mkrepo();
    const { branch, path } = await mkworktree(main);
    const r = await accept(run, { main, base: "main", branch, path });
    assert.equal(r.code, "empty");
  });

  test("wrong-branch and dirty-main", async () => {
    const main = await mkrepo();
    const { branch, path } = await mkworktree(main);
    writeFileSync(join(path, "n.txt"), "x\n");
    await run("git", ["add", "."], { cwd: path });
    await run("git", ["commit", "-m", "w"], { cwd: path });
    await run("git", ["checkout", "-b", "other"], { cwd: main });
    let r = await accept(run, { main, base: "main", branch, path });
    assert.equal(r.code, "wrong-branch");
    assert.equal(r.detail, "other");
    await run("git", ["checkout", "main"], { cwd: main });
    writeFileSync(join(main, "f.txt"), "changed\n");
    r = await accept(run, { main, base: "main", branch, path });
    assert.equal(r.code, "dirty-main");
  });

  test("conflict", async () => {
    const main = await mkrepo();
    const { branch, path } = await mkworktree(main);
    writeFileSync(join(path, "f.txt"), "task-side\n");
    await run("git", ["add", "."], { cwd: path });
    await run("git", ["commit", "-m", "w"], { cwd: path });
    writeFileSync(join(main, "f.txt"), "main-side\n");
    await run("git", ["add", "."], { cwd: main });
    await run("git", ["commit", "-m", "m"], { cwd: main });
    const head = (await run("git", ["-C", main, "rev-parse", "HEAD"])).stdout;
    const r = await accept(run, { main, base: "main", branch, path });
    assert.equal(r.code, "conflict");
    assert.equal((await run("git", ["-C", main, "rev-parse", "HEAD"])).stdout, head);
    assert.ok(!existsSync(join(main, ".git", "MERGE_HEAD")));
    assert.ok(existsSync(path));
    assert.ok((await branches(run, main)).includes(branch));
  });

  test("accept with missing path -> git-failed", async () => {
    const main = await mkrepo();
    const head = (await run("git", ["-C", main, "rev-parse", "HEAD"])).stdout;
    const r = await accept(run, { main, base: "main", branch: "task/nope", path: join(main, "no-such") });
    assert.equal(r.code, "git-failed");
    assert.equal((await run("git", ["-C", main, "rev-parse", "HEAD"])).stdout, head);
    assert.ok(!existsSync(join(main, ".git", "MERGE_HEAD")));
  });

  test("discard after worktree dir deleted still drops branch", async () => {
    const main = await mkrepo();
    const { branch, path } = await mkworktree(main);
    await run("rm", ["-rf", path]);
    const r = await discard(run, { main, branch, path });
    assert.ok(r.ok, JSON.stringify(r));
    assert.ok(!(await branches(run, main)).includes(branch));
    const list = await run("git", ["-C", main, "worktree", "list", "--porcelain"]);
    assert.ok(!list.stdout.includes(`worktree ${path}\n`));
  });

  test("discard removes worktree and branch", async () => {
    const main = await mkrepo();
    const { branch, path } = await mkworktree(main);
    writeFileSync(join(path, "dirty.txt"), "x\n");
    const r = await discard(run, { main, branch, path });
    assert.ok(r.ok, JSON.stringify(r));
    assert.ok(!existsSync(path));
    assert.ok(!(await branches(run, main)).includes(branch));
  });

  test("stat", async () => {
    const main = await mkrepo();
    const { branch, path } = await mkworktree(main);
    writeFileSync(join(path, "s.txt"), "a\nb\n");
    await run("git", ["add", "."], { cwd: path });
    await run("git", ["commit", "-m", "w"], { cwd: path });
    const s = await stat(run, { main, base: "main", branch, path });
    assert.deepEqual(
      { commits: s.commits, files: s.files, insertions: s.insertions, deletions: s.deletions, dirty: s.dirty },
      { commits: 1, files: 1, insertions: 2, deletions: 0, dirty: 0 });
  });

  test("repoOf", async () => {
    const main = await mkrepo();
    const { path } = await mkworktree(main);
    const r = await repoOf(run, path);
    assert.equal(r.ok, true);
    assert.equal(realpathSync(r.main), realpathSync(main));
    assert.equal(r.branch, "main");
    const plain = mkdtempSync(join(tmpdir(), "ht-plain-"));
    const r2 = await repoOf(run, plain);
    assert.equal(r2.code, "not-git");
  });
}
