// herd-tasks v2: Shepherdr-style board. Tasks run as ordinary agent tabs in
// git worktrees; the panel groups them by what they need. Config in
// tasks.json (created from tasks.default.json), state in
// shared("herd-tasks.v2").

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { spaces, agents, panes, focused, run, theme, shared, setShared, openOverlay, closeOverlay, props, exec, knownAgents, readTextFile, writeTextFile, appHome, window, nextCommand } from "herdr";
import { slugify, branchName, sectionOf, nextToStart, launchArgv, taskPrompt, reviewPrompt, mergeTasksConfig, failureMessage } from "./lib.js";
import * as git from "./git.js";

const FILE = "mods/herd-tasks/tasks.json";
const DEFAULT_FILE = "mods/herd-tasks/tasks.default.json";
const KEY = "herd-tasks.v2";
const OLD_KEY = "herd-tasks.tasks";
const CFG = "herd-tasks.cfg"; // {agentCfg, agents, max_running, worktree, err, at}
const DONE_KEEP = 30 * 24 * 3600 * 1000;
const uid = () => `tk${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const seenCmds = new Map(); // one runtime, all mounts share it
let loading = false;

// run() wrapper: routes exec to the task's machine.
const runFor = (machine) => (cmd, args, opts = {}) =>
  exec(cmd, args, { cwd: opts.cwd, on: machine ?? null, timeout: opts.timeout ?? 30000 });

function ensureCfg(cx) {
  const at = shared(CFG)?.at ?? 0;
  if (loading || Date.now() - at < 60000) return;
  loading = true;
  cx.spawn(async () => {
    try {
      const d = { agentCfg: {}, agents: [], max_running: 4, worktree: true, err: null, at: Date.now() };
      try {
        const c = mergeTasksConfig(await readTextFile(`${appHome()}/${DEFAULT_FILE}`), await readTextFile(`${appHome()}/${FILE}`));
        d.agentCfg = c.agentCfg; d.max_running = c.max_running; d.worktree = c.worktree;
      } catch (e) { d.err = `${e}`; }
      try { d.agents = await knownAgents({}); } catch {}
      const known = new Set(d.agents.map(a => a.key));
      for (const [key, cfg] of Object.entries(d.agentCfg)) {
        if (known.has(key) || !cfg?.run?.length) continue;
        let installed = false;
        try { installed = (await exec("sh", ["-c", 'command -v "$0" >/dev/null', cfg.run[0]])).code === 0; } catch {}
        d.agents.push({ key, name: cfg.name ?? key, icon: null, tint: false, run: cfg.run, installed });
      }
      setShared(CFG, d);
    } finally { loading = false; }
  });
}
const cfg = () => shared(CFG) ?? { agentCfg: {}, agents: [], max_running: 4, worktree: true };

const tasks = () => ({ ...(shared(KEY) ?? {}) });
const saveTasks = (t) => setShared(KEY, Object.fromEntries(Object.entries(t).filter(([, e]) => !(e.state === "done" && Date.now() - (e.finished ?? 0) > DONE_KEEP))));
const putTask = (t) => { const all = tasks(); all[t.id] = t; saveTasks(all); };
const delTask = (id) => { const all = tasks(); delete all[id]; saveTasks(all); };

const allTabs = () => new Map(spaces().flatMap(s => (s.tabs ?? []).map(t => [t.id, { ...t, space: s.id, space_name: s.name, machine: s.machine }])));

function migrateOnce() {
  if (shared(KEY) !== undefined || shared(OLD_KEY) === undefined) return;
  const out = {};
  for (const [id, e] of Object.entries(shared(OLD_KEY) ?? {})) {
    const live = allTabs().has(e.tab);
    out[id] = { id, title: e.title ?? "task", brief: "", space: e.space ?? null, machine: null,
      repo: null, base: null, branch: null, path: null, worktree: false,
      agent: e.agent ?? null, model: null, tab: live ? e.tab : (e.tab ?? null), review_tab: null,
      state: e.done || !live && e.tab ? "done" : (e.tab ? "running" : "todo"),
      merged: false, error: null, created: e.created ?? Date.now(),
      started: e.tab ? e.created ?? Date.now() : null, finished: e.done || (!live && e.tab) ? (e.doneAt ?? Date.now()) : null };
  }
  saveTasks(out);
}

async function newTab({ name, space, folder, argv, task }) {
  const spec = ["do", "tab.new", "--name", name];
  if (space) spec.push("--space", space);
  if (folder) spec.push("--folder", folder);
  if (argv) spec.push("--argv", JSON.stringify(argv));
  if (task) spec.push("--task", task);
  const r = await exec("herdr-app", spec);
  const out = JSON.parse(r.stdout);
  if (out.error) throw new Error(out.error);
  return out.tab;
}

async function startTask(t, opts, cfgd) {
  const space = spaces().find(s => s.id === t.space);
  const machine = space?.machine ?? t.machine ?? null;
  const run = runFor(machine);
  const agent = cfgd.agents.find(a => a.key === t.agent && a.installed) ?? cfgd.agents.find(a => a.installed);
  const argv = launchArgv(agent?.run ?? [t.agent ?? "claude"], cfgd.agentCfg[agent?.key], t.model);
  if (t.worktree) {
    const repo = await git.repoOf(run, t.path || space?.folder);
    if (!repo.ok) { t.error = failureMessage(repo.code, repo.detail); return false; }
    t.repo = repo.main;
    t.base = repo.branch;
    t.branch = branchName(t.title, await git.branches(run, repo.main));
    const home = (await run("sh", ["-c", 'printf %s "$HOME"'])).stdout.trim();
    t.path = `${home}/.herdr/worktrees/${repo.name}/${t.branch.replace(/\//g, "-")}`;
    const st = await git.start(run, { main: repo.main, base: repo.base ?? repo.branch, branch: t.branch, path: t.path });
    if (!st.ok) { t.error = failureMessage(st.code, st.detail); return false; }
  } else {
    t.path = space?.folder ?? t.path;
  }
  try {
    t.tab = await newTab({ name: t.title, space: t.space, folder: t.path, argv, task: taskPrompt(t) });
  } catch (e) { t.error = `${e.message}`; return false; }
  t.state = "running"; t.started = Date.now(); t.error = null;
  return true;
}

const SECTIONS = [
  { id: "needs", label: "Needs you" }, { id: "ready", label: "Ready" },
  { id: "working", label: "Working" }, { id: "queued", label: "Queued" },
  { id: "todo", label: "To do" }, { id: "done", label: "Done" }];
const MARK = { needs: ["blocked", "dot"], ready: ["done", "dot"], working: ["working", "spin"], queued: ["dim", "ring"], todo: ["dim", "ring"], done: ["dim", "check"] };

function age(ts) {
  const m = Math.floor((Date.now() - (ts ?? Date.now())) / 60000);
  return m < 1 ? "now" : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
}

export default class HerdTasks extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.handle = cx.focus_handle();
    this.scope = localStorage.getItem("tasks.scope") ?? "space";
    this.expanded = null;
    this.stat = null;
    this.optionsOpen = localStorage.getItem("tasks.opts") === "1";
    migrateOnce();
    if (p.confirm) {
      this.task = p.task; this.confirmAction = p.action;
      return;
    }
    this.composer = TextareaState.new({ value: "", placeholder: "What needs doing? The first line is the title. Enter starts." });
    this.composer.set_auto_grow(1, 5);
    this.composer.on("submit", (_e, cx) => this.create(cx, true));
    this.composer.on("focus", (_e, cx) => { this.cFocus = true; cx.notify(); });
    this.composer.on("blur", (_e, cx) => { this.cFocus = false; cx.notify(); });
    this.modelInput = InputState.new({ value: "", placeholder: "other model id" });
    this.modelInput.on("change", (_e, cx) => { this.model = this.modelInput.value().trim() || null; cx.notify(); });
    const space = spaces().find(s => s.active);
    const saved = JSON.parse(localStorage.getItem(`tasks.opts.${space?.id}`) ?? "{}");
    this.savedAgent = saved.agent ?? null;
    this.agentKey = saved.agent && cfg().agents.find(a => a.key === saved.agent && a.installed) ? saved.agent
      : cfg().agents.find(a => a.installed)?.key ?? null;
    this.model = saved.model ?? null;
    this.wt = saved.worktree ?? cfg().worktree;
    this.repoInfo = null;
    this.probeSpaceId = null;
    this.probeRepo(cx);
    cx.timer.every(5000, (cx) => this.tick(cx));
    cx.timer.every(10000, (cx) => { if (this.expanded) this.refreshStat(cx); });
    cx.spawn(async () => {
      for (;;) {
        const c = await nextCommand();
        // Dedupe only commands with shared side effects (state changes,
        // opened tabs/dialogs) — one handling across all mounts. "new" is
        // instance-local UI state: every copy selects and focuses itself.
        const once = /^(start|open|review|accept|discard|rebase|reopen|remove):/.test(c) || c === "track";
        if (once) {
          if (seenCmds.has(c) && Date.now() - seenCmds.get(c) < 2000) continue;
          seenCmds.set(c, Date.now());
        }
        // A sync throw here would reject this spawn and kill the command
        // loop for the mount's whole lifetime — swallow per command, and
        // un-mark so a surviving mount can still handle it.
        try {
          if (c === "new") {
            run("layout.select", { stack: "panel-body", child: "herd-tasks" });
            run("layout.show", { id: "panel" });
            this.composer.focus();
          } else if (c === "track") {
            this.trackCurrent();
          } else if (/^(start|open|review|accept|discard|rebase|reopen|remove):/.test(c)) {
            const [cmd, id] = c.split(":", 2);
            const t = tasks()[id];
            if (t) this.action(cx, t, cmd);
          } else if (c === "close") {
            // Not deduped: every mount sees it; only the kept-window mount
            // (the one with props().overlay) closes itself.
            if (props().overlay) closeOverlay(props().overlay);
          }
        } catch {
          if (once) seenCmds.delete(c);
        }
        cx.notify();
      }
    });
    ensureCfg(cx);
  }

  async probeRepo(cx) {
    const space = spaces().find(s => s.active) ?? spaces().find(s => s.id === focused()?.space);
    const sid = space?.id ?? null;
    if (sid === this.probeSpaceId) return;
    this.probeSpaceId = sid;
    if (!space?.folder) { this.repoInfo = null; cx.notify(); return; }
    try {
      const r = await git.repoOf(runFor(space.machine), space.folder);
      if (this.probeSpaceId === sid) this.repoInfo = r;
    } catch { if (this.probeSpaceId === sid) this.repoInfo = null; }
    cx.notify();
  }

  async tick(cx) {
    const all = Object.values(tasks());
    const start = nextToStart(all, cfg().max_running);
    for (const t of start) {
      // claim the task before starting so two mounts never start it twice
      const cur = tasks()[t.id];
      if (!cur || cur.state !== "queued") continue;
      cur.state = "starting"; putTask(cur);
      const ok2 = await startTask(cur, {}, cfg());
      if (!ok2) { cur.state = "todo"; putTask(cur); }
      else putTask(cur);
    }
    if (start.length) cx.notify();
  }

  create(cx, startNow) {
    const text = this.composer.value().trim();
    if (!text) return;
    const [title, ...rest] = text.split("\n");
    const space = spaces().find(s => s.active);
    const t = { id: uid(), title: title.trim() || "task", brief: rest.join("\n").trim(),
      space: space?.id ?? null, machine: space?.machine ?? null,
      repo: null, base: null, branch: null, path: space?.folder ?? null,
      worktree: Boolean(this.wt && this.repoInfo?.ok),
      agent: this.agentKey, model: this.modelInput?.value().trim() || this.model,
      tab: null, review_tab: null, state: "todo", merged: false, error: null,
      created: Date.now(), started: null, finished: null };
    if (startNow) t.state = "queued";
    putTask(t);
    if (space) localStorage.setItem(`tasks.opts.${space.id}`, JSON.stringify({ agent: this.agentKey, model: t.model, worktree: this.wt }));
    this.composer.set_value("");
    if (startNow) this.tick(cx);
    cx.notify();
  }

  // Adopt the focused tab as a tracked running task (footer button and the
  // `herd-tasks.track` command share this path).
  trackCurrent() {
    const tab = allTabs().get(focused()?.tab);
    if (!tab) return;
    const pane = panes().find(pn => pn.tab === tab.id);
    putTask({ id: uid(), title: tab.name ?? "tab", brief: "", space: tab.space ?? null, machine: tab.machine ?? null,
      repo: null, base: null, branch: null, path: pane?.cwd ?? spaces().find(sp => sp.id === tab.space)?.folder ?? null,
      worktree: false, agent: null, model: null,
      tab: tab.id, review_tab: null, state: "running", merged: false, error: null,
      created: Date.now(), started: Date.now(), finished: null });
  }

  async refreshStat(cx) {
    const t = tasks()[this.expanded];
    if (!t?.worktree || !t.repo) { this.stat = null; return; }
    try { this.stat = await git.stat(runFor(t.machine), { main: t.repo, base: t.base, branch: t.branch, path: t.path }); }
    catch { this.stat = null; }
    cx.notify();
  }

  findTab(t, key) {
    const tabs = allTabs();
    return key === "review" ? tabs.get(t.review_tab) : tabs.get(t.tab);
  }

  async action(cx, t, what) {
    const tabs = allTabs();
    if (what === "start" && (t.state === "todo" || t.state === "queued")) {
      t.state = "queued"; putTask(t); await this.tick(cx);
    } else if (what === "open" || what === "reopen") {
      const tab = tabs.get(t.tab);
      if (what === "reopen" && !tab) {
        const nt = await newTab({ name: t.title, space: t.space, folder: t.path });
        const cur = tasks()[t.id]; cur.tab = nt; putTask(cur);
      } else {
        const agent = agents().find(a => a.tab === t.tab);
        if (agent) run("agent.focus", { terminal: agent.address }); else run("tab.select", { id: t.tab });
      }
    } else if (what === "review") {
      if (t.review_tab && tabs.has(t.review_tab)) { run("tab.select", { id: t.review_tab }); return; }
      const agent = cfg().agents.find(a => a.key === t.agent && a.installed) ?? cfg().agents.find(a => a.installed);
      const argv = launchArgv(agent?.run ?? ["claude"], cfg().agentCfg[agent?.key], t.model);
      const nt = await newTab({ name: `Review: ${t.title}`, space: t.space, folder: t.path, argv, task: reviewPrompt(t) });
      const cur = tasks()[t.id]; cur.review_tab = nt; putTask(cur);
    } else if (what === "accept") {
      if (!t.worktree) { const cur = tasks()[t.id]; cur.state = "done"; cur.finished = Date.now(); putTask(cur); return; }
      const r = await git.accept(runFor(t.machine), { main: t.repo, base: t.base, branch: t.branch, path: t.path });
      const cur = tasks()[t.id];
      if (r.ok) {
        cur.state = "done"; cur.merged = true; cur.finished = Date.now(); cur.error = null;
        cur.leftover = r.leftover ?? null;
        for (const id of [cur.tab, cur.review_tab].filter(Boolean)) {
          try { run("tab.close", { id, confirmed: true }); } catch {}
        }
        cur.tab = null; cur.review_tab = null;
      } else {
        cur.error = failureMessage(r.code, r.detail, cur);
        cur.errorAction = r.code === "conflict" ? "rebase" : null;
      }
      putTask(cur);
    } else if (what === "rebase") {
      const addr = agents().find(a => a.tab === t.tab)?.address;
      if (addr) {
        const line = `The merge into ${t.base} hit conflicts. Rebase this branch onto ${t.base}, resolve the conflicts, re-run the checks, commit, and tell me when it is done.`;
        try { await exec("hc", ["send", addr, line]); } catch (e) { console.log(`herd-tasks rebase: ${e}`); }
      }
      const cur = tasks()[t.id]; cur.error = null; cur.errorAction = null; putTask(cur);
    } else if (what === "discard") {
      openOverlay({ mod: "herd-tasks", kind: "dialog", width: 420, height: 175, props: { confirm: true, task: t.id, action: "discard" } });
    } else if (what === "remove") {
      delTask(t.id);
    }
    cx.notify();
  }

  async doDiscard(cx) {
    const t = tasks()[this.task];
    closeOverlay(props()?.overlay);
    if (!t) return;
    for (const id of [t.tab, t.review_tab].filter(Boolean)) {
      try { run("tab.close", { id, confirmed: true }); } catch {}
    }
    if (t.worktree && t.repo) {
      const r = await git.discard(runFor(t.machine), { main: t.repo, branch: t.branch, path: t.path });
      if (!r.ok) {
        const cur = tasks()[t.id];
        if (cur) { cur.error = failureMessage(r.code, r.detail); putTask(cur); }
        cx.notify();
        return;
      }
    }
    delTask(t.id);
    cx.notify();
  }

  confirmDialog(t) {
    const p = props() ?? {};
    const task = tasks()[this.task];
    const close = () => closeOverlay(p.overlay);
    if (!task) { close(); return div(); }
    const danger = t.ansi1 ?? t.blocked;
    const btn = (id, label, isDanger, action) => h_flex().id(id).h(32).px(14).items_center().rounded(8).flex_none()
      .border_1().border_color(isDanger ? danger : t.input).bg(isDanger ? danger : t.raised)
      .text_color(isDanger ? "#ffffff" : t.foreground).text_size(12.5).font_medium().cursor_pointer()
      .hover(s => s.opacity(0.88)).on_click(action).child(label);
    return v_flex().id("ht-confirm").track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape") { close(); cx.stop_propagation(); } })
      .w_full().min_h(0).p(18).bg(t.popover).text_color(t.foreground).text_size(12.8)
      .child(div().flex_none().text_size(15).font_semibold().child(`Discard “${task.title}”?`))
      .child(div().flex_none().pt(10).text_size(12).text_color(t.muted)
        .child(`This closes its tab and deletes its worktree and the branch ${task.branch}, including any uncommitted work. This cannot be undone.`))
      .child(div().flex_1())
      .child(h_flex().flex_none().pt(16).gap(8).justify_end()
        .child(btn("cf-cancel", "Cancel", false, close))
        .child(btn("cf-discard", "Discard", true, (_e, cx) => this.doDiscard(cx))));
  }

  chip(t, id, label, on, tip) {
    return h_flex().id(id).h(24).px(8).mr(6).items_center().rounded(6).flex_none()
      .border_1().border_color(on ? t.accent : t.input).bg(on ? t.accent + "1f" : t.raised)
      .text_color(on ? t.accent : t.muted).text_size(11).cursor_pointer()
      .when(tip, el => el.tooltip(tip));
  }

  card(t, task, tab, sec, expanded) {
    const [color, kind] = MARK[sec.section] ?? MARK.todo;
    if (task.error && !expanded) this.expanded = task.id;
    const needLine = task.error ? task.error
      : sec.section === "needs" ? "Needs you"
      : task.state === "starting" ? "Starting…"
      : sec.section === "working" ? "Working"
      : sec.section === "ready" ? (sec.closed ? "Ready · tab closed" : "Ready")
      : sec.section === "queued" ? "Queued" : sec.section === "done" ? "Done" : "";
    const statLine = this.stat?.ok && expanded
      ? ` · ${this.stat.commits} commits · ${this.stat.files} files +${this.stat.insertions} −${this.stat.deletions}${this.stat.dirty ? ` · ${this.stat.dirty} dirty` : ""}` : "";
    const agentLine = task.agent ? ` · ${task.agent}${task.model ? ` · ${task.model}` : ""}` : "";
    const act = (id, label, danger, fn) => h_flex().id(`a-${id}-${task.id}`).h(24).px(8).mr(5).items_center().rounded(6).flex_none()
      .bg(danger ? (t.ansi1 ?? t.blocked) + "22" : t.surface).border_1().border_color(danger ? (t.ansi1 ?? t.blocked) : t.input)
      .text_size(10.5).text_color(danger ? (t.ansi1 ?? t.blocked) : t.muted).cursor_pointer()
      .hover(s => s.border_color(t.accent).text_color(danger ? (t.ansi1 ?? t.blocked) : t.foreground))
      .on_click((_e, cx) => { cx.stop_propagation(); fn(cx); }).child(label);
    const mark = kind === "spin" ? svg("mods/workspace-chrome/spinner.svg").size(12).text_color(t[color]).spin(900)
      : kind === "dot" ? div().size(7).rounded_full().bg(t[color])
      : kind === "check" ? div().size(7).rounded(2).border_1().border_color(t.dim).bg(t.dim + "55")
      : div().size(7).rounded_full().border_1().border_color(t.dim);
    const actions = [];
    const go = (w) => (cx) => this.action(cx, task, w);
    if (task.error) {
      if (task.errorAction === "rebase") actions.push(act("rebase", "Ask agent to rebase", false, go("rebase")));
      actions.push(act("err-accept", "Accept", false, go("accept")), act("err-discard", "Discard", true, go("discard")));
    } else if (task.state === "todo") actions.push(act("start", "Start", false, go("start")), act("rm", "Remove", true, go("remove")));
    else if (task.state === "queued") actions.push(act("start", "Start now", false, go("start")), act("rm", "Remove", true, go("remove")));
    else if (task.state === "done") actions.push(act("rm", "Remove", false, go("remove")));
    else if (sec.closed) {
      actions.push(act("reopen", "Reopen", false, go("reopen")));
      actions.push(task.worktree ? act("accept", "Accept", false, go("accept")) : act("done", "Mark done", false, go("accept")));
      actions.push(task.worktree ? act("discard", "Discard", true, go("discard")) : act("rm", "Remove", true, go("remove")));
    }
    else {
      actions.push(act("open", "Open", false, go("open")));
      if (sec.section === "ready") {
        actions.push(act("review", task.review_tab ? "Open review" : "Review", false, go("review")));
        actions.push(task.worktree ? act("accept", "Accept", false, go("accept")) : act("done", "Mark done", false, go("accept")));
      }
      actions.push(task.worktree ? act("discard", "Discard", true, go("discard")) : act("rm", "Remove", true, go("remove")));
    }
    return v_flex().id(`task-${task.id}`).flex_none().mx(10).mb(6).px(10).py(8).rounded(10).bg(t.raised)
      .border_1().border_color(expanded ? t.input : t.border).gap(5).cursor_pointer()
      .hover(s => s.border_color(t.input))
      .on_click((_e, cx) => { this.expanded = expanded ? null : task.id; this.stat = null; if (this.expanded) this.refreshStat(cx); cx.notify(); })
      .child(h_flex().gap(7).items_center()
        .child(mark)
        .child(div().flex_1().min_w(0).truncate().font_medium().text_size(12.5).text_color(task.state === "done" ? t.muted : t.foreground).child(task.title))
        .child(div().text_size(10).text_color(t.dim).child(age(task.created))))
      .child(div().text_size(10.5).text_color(task.error ? (t.ansi1 ?? t.blocked) : t.dim)
        .child(`${needLine}${sec.section === "ready" && !sec.closed ? statLine : ""}${agentLine}`))
      .when(expanded, el => el
        .when(Boolean(task.brief), e => e.child(div().text_size(11).text_color(t.muted).child(task.brief)))
        .when(Boolean(task.branch), e => e.child(div().text_size(10.5).text_color(t.dim).child(`${task.branch} from ${task.base}`)))
        .when(Boolean(task.path), e => e.child(div().truncate().text_size(10.5).text_color(t.dim).child(task.path)))
        .when(Boolean(task.leftover), e => e.child(div().text_size(10.5).text_color(t.dim).child(`leftover: ${task.leftover}`)))
        .child(h_flex().items_center().pt(2).children(actions)));
  }

  render(cx) {
    // A throw here bricks the mount (frozen frame, dead clicks) — show an
    // error strip instead so a transient bad state can't take it down.
    try {
      return this.renderBody(cx);
    } catch (e) {
      const t = theme();
      return div().size_full().p(10).text_size(11).text_color(t.muted)
        .child(`herd-tasks render error: ${e}`);
    }
  }

  renderBody(cx) {
    const t = theme();
    const p = props() ?? {};
    if (p.confirm) return this.confirmDialog(t);
    ensureCfg(cx);
    const cfgd = cfg();
    const space = spaces().find(s => s.active);
    const tabs = allTabs();
    const now = Date.now();
    const mine = this.scope === "space" && space ? (tk) => tk.space === space.id : () => true;
    const groups = Object.fromEntries(SECTIONS.map(s => [s.id, []]));
    for (const task of Object.values(tasks()).filter(mine)) {
      const sec = sectionOf(task, tabs.get(task.tab), now);
      (groups[sec.section] ?? groups.todo).push({ task, sec });
    }
    if (!this.agentKey || !cfgd.agents.find(a => a.key === this.agentKey && a.installed)) {
      this.agentKey = this.savedAgent && cfgd.agents.find(a => a.key === this.savedAgent && a.installed) ? this.savedAgent
        : cfgd.agents.find(a => a.installed)?.key ?? null;
    }
    const agent = cfgd.agents.find(a => a.key === this.agentKey);
    const model = this.modelInput?.value().trim() || this.model;
    const wtOn = Boolean(this.wt && this.repoInfo?.ok);
    const summary = `${agent?.name ?? this.agentKey ?? "?"} · ${model ?? "default"} · ${wtOn ? `worktree from ${this.repoInfo?.branch ?? "?"}` : "no worktree"}`;
    const chip = (id, label, on, fn, tip) => this.chip(t, id, label, on, tip)
      .when(fn, el => el.on_click(fn)).child(label);
    const agentCfg = cfgd.agentCfg[this.agentKey] ?? {};
    const scopeBtn = (id, label) => div().id(`scope-${id}`).h(24).px(10).rounded(6).flex().items_center().cursor_pointer()
      .text_size(11).text_color(this.scope === id ? t.foreground : t.dim)
      .bg(this.scope === id ? t.selected : "#00000000").hover(s => s.text_color(t.foreground))
      .on_click((_e, cx) => { this.scope = id; localStorage.setItem("tasks.scope", id); cx.notify(); }).child(label);
    const folded = new Set(["done"]);
    this.fold = this.fold ?? new Set(["done"]);
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(h_flex().px(14).h(44).flex_none().items_center().gap(8).border_b(1).border_color(t.border)
        .child(div().text_size(13).font_semibold().child("Tasks"))
        .when(groups.needs.length > 0, el => el.child(
          div().h(20).px(7).rounded(6).bg((t.ansi1 ?? t.blocked) + "1f").text_color(t.ansi1 ?? t.blocked).text_size(10.5).font_medium().flex().items_center()
            .child(String(groups.needs.length))))
        .when(groups.ready.length > 0, el => el.child(
          div().h(20).px(7).rounded(6).bg(t.done + "1f").text_color(t.done).text_size(10.5).font_medium().flex().items_center()
            .child(String(groups.ready.length))))
        .child(div().flex_1())
        .child(scopeBtn("space", "This space"))
        .child(scopeBtn("all", "All"))
        .when(p.overlay, el => el.child(
          div().id("ht-close").size(22).rounded(6).flex_none().flex().items_center().justify_center().cursor_pointer()
            .hover(s => s.bg(t.hover)).tooltip("Close")
            .on_click(() => closeOverlay(p.overlay))
            .child(svg("mods/pane/close.svg").size(12).text_color(t.muted)))))
      .child(v_flex().flex_none().px(12).py(10).gap(8).border_b(1).border_color(t.border)
        .child(Textarea.new(this.composer).min_h(34).py(7).px(10).rounded(9).border_1().border_color(this.cFocus ? t.accent : t.input).bg(t.background).text_color(t.foreground).text_size(12.5))
        .child(h_flex().items_center().gap(8)
          .child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.dim).child(summary))
          .child(chip("opts", "Options", this.optionsOpen, () => { this.optionsOpen = !this.optionsOpen; localStorage.setItem("tasks.opts", this.optionsOpen ? "1" : "0"); }))
          .child(chip("later", "Later", false, (_e, cx) => this.create(cx, false)))
          .child(h_flex().id("start").h(24).px(10).items_center().rounded(6).flex_none()
            .bg(t.solid).text_color(t.solid_foreground).text_size(11).font_medium().cursor_pointer()
            .hover(s => s.opacity(0.88))
            .on_click((_e, cx) => this.create(cx, true)).child("Start")))
        .when(this.optionsOpen, el => el
          .child(h_flex().items_center().overflow_x_scrollbar().flex_none()
            .children(cfgd.agents.filter(a => a.installed).map(a =>
              chip(`ag-${a.key}`, a.name, this.agentKey === a.key, () => { this.agentKey = a.key; this.model = null; this.modelInput?.set_value(""); }))))
          .when(Boolean(agentCfg.model_flag), e => e.child(h_flex().items_center().overflow_x_scrollbar().flex_none()
            .child(chip("md-def", "Default", this.model === null && !this.modelInput?.value().trim(), () => { this.model = null; this.modelInput.set_value(""); }))
            .children((agentCfg.models ?? []).map(m => chip(`md-${m}`, m, this.model === m && !this.modelInput?.value().trim(), () => { this.model = m; this.modelInput.set_value(""); })))
            .child(Input.new(this.modelInput).h(24).w(120).px(8).ml(2).rounded(6).border_1().border_color(t.input).bg(t.background).text_color(t.foreground).text_size(11))))
          .child(chip("wt", "worktree", wtOn,
            this.repoInfo?.ok ? () => { this.wt = !this.wt; } : null,
            this.repoInfo?.ok ? null : "This space is not a git repository"))))
      .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar().pb(8)
        .children(SECTIONS.filter(sec => groups[sec.id].length > 0).map(sec => {
          const items = groups[sec.id];
          const open = !this.fold.has(sec.id);
          return v_flex().flex_none()
            .child(h_flex().id(`sec-${sec.id}`).px(12).h(30).gap(7).items_center().text_size(11).font_medium().cursor_pointer()
              .text_color(sec.id === "needs" && items.length ? (t.ansi1 ?? t.blocked) : t.dim)
              .on_click((_e, cx) => { open ? this.fold.add(sec.id) : this.fold.delete(sec.id); cx.notify(); })
              .child(div().text_size(9).child(open ? "▾" : "▸"))
              .child(`${sec.label} ${items.length}`))
            .when(open, el => el.children(items.map(({ task, sec: s }) => this.card(t, task, tabs.get(task.tab), s, this.expanded === task.id))));
        }))
        .when(Object.values(tasks()).filter(mine).length === 0, el => el.child(
          div().px(16).py(14).text_size(12).text_color(t.dim).child("No tasks yet. Write what needs doing above."))))
      .child(h_flex().px(14).h(26).flex_none().items_center().border_t(1).border_color(t.border)
        .child(div().id("ht-track").text_size(10).text_color(t.dim).cursor_pointer()
          .hover(s => s.text_color(t.accent))
          .on_click((_e, cx) => { this.trackCurrent(); cx.notify(); })
          .child("Track current tab")));
  }
}
