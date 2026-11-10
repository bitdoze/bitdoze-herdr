// herd-tasks pure logic: no herdr/gpui imports so `node --test` can run it.

export function slugify(title) {
  let s = String(title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  s = s.slice(0, 40).replace(/-+$/g, "");
  return s || "task";
}

export function branchName(title, existing) {
  const base = `task/${slugify(title)}`;
  if (!existing.includes(base)) return base;
  for (let i = 2; ; i++) {
    const b = `${base}-${i}`;
    if (!existing.includes(b)) return b;
  }
}

export function sectionOf(task, tab, now) {
  if (task.state === "starting") return { section: "working", closed: false };
  if (task.state === "todo") return { section: "todo", closed: false };
  if (task.state === "queued") return { section: "queued", closed: false };
  if (task.state === "done") return { section: "done", closed: false };
  // running
  if (!tab) return { section: "ready", closed: true };
  if (tab.status === "blocked") return { section: "needs", closed: false };
  if (tab.status === "working") return { section: "working", closed: false };
  if (tab.status === "done") return { section: "ready", closed: false };
  if (now - (task.started ?? 0) < 20000) return { section: "working", closed: false };
  return { section: "ready", closed: false };
}

export function nextToStart(tasks, max) {
  const running = tasks.filter(t => t.state === "running" || t.state === "starting").length;
  const slots = Math.max(0, max - running);
  return tasks.filter(t => t.state === "queued")
    .sort((a, b) => (a.created ?? 0) - (b.created ?? 0))
    .slice(0, slots);
}

export function launchArgv(run, cfg, model) {
  const m = (model ?? "").trim();
  if (cfg?.model_flag && m) return [...run, cfg.model_flag, m];
  return [...run];
}

export function taskPrompt(task) {
  if (!task.worktree) {
    return `You are working on one task.

Task: ${task.title}
${task.brief ? `${task.brief}\n` : ""}
Rules:
- Work in this folder (${task.path}). Keep the change limited to what the task needs.
- Before you say you are finished: run the checks this project has for what you changed.
- Finish with a short summary: what changed, how you verified it, and anything left open.
- If you need a decision from the person, ask and wait.`;
  }
  return `You are working on one task, in its own git worktree.

Task: ${task.title}
${task.brief ? `${task.brief}\n` : ""}
Rules:
- Work only in this folder (${task.path}), on the branch ${task.branch}. Do not touch the main checkout (${task.repo}) or any other branch.
- Commit your work on this branch as you go, with clear messages. Do not merge, push or open a pull request.
- Before you say you are finished: run the checks this project has for what you changed, and make sure everything is committed.
- Finish with a short summary: what changed, how you verified it, and anything left open.
- If you need a decision from the person, ask and wait.`;
}

export function reviewPrompt(task) {
  return `You are reviewing one finished task with fresh eyes. Do not edit, commit or merge anything.

Task: ${task.title}
${task.brief ? `${task.brief}\n` : ""}
The work is on the branch ${task.branch} in this folder; it started from ${task.base}. Read the change with:
  git log --oneline ${task.base}..HEAD
  git diff ${task.base}...HEAD
Check that it does what the task asked, and look for bugs, missed edge cases, broken callers and missing tests. Run the project's checks if that is cheap.

Report findings as a list, most serious first: severity, file:line, what is wrong, the fix you suggest. End with one line: "VERDICT: ready to merge" or "VERDICT: needs work".`;
}

export function mergeTasksConfig(defText, userText) {
  const def = JSON.parse(defText ?? "{}");
  const usr = userText === null || userText === undefined ? null : JSON.parse(userText);
  return {
    agentCfg: { ...(def.agents ?? {}), ...(usr?.agents ?? {}) },
    max_running: usr?.max_running ?? def.max_running ?? 4,
    worktree: usr?.worktree ?? def.worktree ?? true,
  };
}

export function failureMessage(code, detail, ctx) {
  switch (code) {
    case "dirty-task": return "The task has uncommitted changes. Ask its agent to commit, then accept again.";
    case "empty": return "Nothing to merge: the branch has no commits.";
    case "wrong-branch": return `The main checkout is on ${detail}, not ${ctx?.base}. Switch it back, then accept again.`;
    case "dirty-main": return "The main checkout has uncommitted changes. Commit or stash them, then accept again.";
    case "conflict": return `Merging into ${ctx?.base} hit conflicts and was undone. Ask the agent to rebase, then accept again.`;
    case "worktree-failed": return `Creating the worktree failed: ${detail}`;
    case "discard-failed": return `Discarding failed: ${detail}`;
    case "not-git": return `This space is not a git repository.`;
    case "detached": return `The main checkout is on a detached HEAD. Check out a branch first.`;
    case "git-failed": return `Git could not read the task: ${detail}`;
    default: return detail || code;
  }
}
