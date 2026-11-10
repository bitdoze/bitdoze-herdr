// herd-tasks git ops. No app imports. `run(cmd, args, {cwd})` is injected by
// the caller (herdr exec in the mod, child_process in tests). Each function
// returns {ok:true,...} or {ok:false, code, detail}; never throws on git
// failure; never uses --force except discard().

const ok = (x = {}) => ({ ok: true, ...x });
const fail = (code, detail) => ({ ok: false, code, detail });

async function git(run, main, args) {
  return run("git", ["-C", main, ...args]);
}

export async function repoOf(run, folder) {
  const r = await run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: folder });
  if (r.code !== 0) return fail("not-git", firstLine(r.stderr));
  const gitdir = r.stdout.trim();
  const main = gitdir.endsWith("/.git") || gitdir.endsWith("\\.git")
    ? gitdir.slice(0, -5)
    : gitdir;
  const b = await git(run, main, ["symbolic-ref", "--short", "HEAD"]);
  if (b.code !== 0) return fail("detached", firstLine(b.stderr));
  const name = main.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
  return ok({ main, name, branch: b.stdout.trim() });
}

export async function branches(run, main) {
  const r = await git(run, main, ["branch", "--format=%(refname:short)"]);
  if (r.code !== 0) return [];
  return r.stdout.split("\n").map(s => s.trim()).filter(Boolean);
}

export async function start(run, { main, base, branch, path }) {
  const r = await git(run, main, ["worktree", "add", "-b", branch, path, base]);
  if (r.code !== 0) return fail("worktree-failed", firstLine(r.stderr));
  return ok();
}

export async function stat(run, { main, base, branch, path }) {
  const c = await git(run, main, ["rev-list", "--count", `${base}..${branch}`]);
  const d = await git(run, main, ["diff", "--shortstat", `${base}...${branch}`]);
  const st = await git(run, path, ["status", "--porcelain"]);
  for (const r of [c, d, st]) if (r.code !== 0) return fail("git-failed", firstLine(r.stderr));
  const m = d.stdout.match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/);
  return ok({
    commits: parseInt(c.stdout.trim() || "0", 10),
    files: m ? parseInt(m[1], 10) : 0,
    insertions: m && m[2] ? parseInt(m[2], 10) : 0,
    deletions: m && m[3] ? parseInt(m[3], 10) : 0,
    dirty: st.stdout.split("\n").filter(l => l.trim()).length,
  });
}

export async function accept(run, { main, base, branch, path }) {
  const need = (r) => r.code === 0;
  const gfail = (r) => fail("git-failed", firstLine(r.stderr));
  const dirty = await git(run, path, ["status", "--porcelain"]);
  if (!need(dirty)) return gfail(dirty);
  if (dirty.stdout.trim()) return fail("dirty-task");
  const count = await git(run, main, ["rev-list", "--count", `${base}..${branch}`]);
  if (!need(count)) return gfail(count);
  if (count.stdout.trim() === "0") return fail("empty");
  const on = await git(run, main, ["symbolic-ref", "--short", "HEAD"]);
  if (!need(on)) return gfail(on);
  if (on.stdout.trim() !== base) return fail("wrong-branch", on.stdout.trim());
  const md = await git(run, main, ["status", "--porcelain", "--untracked-files=no"]);
  if (!need(md)) return gfail(md);
  if (md.stdout.trim()) return fail("dirty-main");
  const merge = await git(run, main, ["merge", "--no-ff", "--no-edit", branch]);
  if (merge.code !== 0) {
    await git(run, main, ["merge", "--abort"]);
    return fail("conflict", firstLine(merge.stderr));
  }
  const w = await git(run, main, ["worktree", "remove", path]);
  if (w.code !== 0) return ok({ merged: true, leftover: firstLine(w.stderr) });
  const b = await git(run, main, ["branch", "-d", branch]);
  if (b.code !== 0) return ok({ merged: true, leftover: firstLine(b.stderr) });
  return ok({ merged: true });
}

export async function discard(run, { main, branch, path }) {
  let detail = null;
  const w = await git(run, main, ["worktree", "remove", "--force", path]);
  if (w.code !== 0) {
    detail = firstLine(w.stderr);
    const pr = await git(run, main, ["worktree", "prune"]);
    if (pr.code !== 0) detail = detail ?? firstLine(pr.stderr);
  }
  const b = await git(run, main, ["branch", "-D", branch]);
  if (b.code !== 0) detail = detail ?? firstLine(b.stderr);
  const still = await git(run, main, ["worktree", "list", "--porcelain"]);
  const listed = still.code === 0 && still.stdout.split("\n").some(l => l === `worktree ${path}`);
  const gone = !(await branches(run, main)).includes(branch);
  if (!gone || listed) return fail("discard-failed", detail ?? "worktree or branch still present");
  return ok();
}

const firstLine = (s) => (s ?? "").split("\n").find(l => l.trim())?.trim() ?? "";
