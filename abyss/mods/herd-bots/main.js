// herd-bots: persona bots, Grok-style. Each bot is a named agent tab started
// with the persona as its first message, so bots behave like any agent: they
// land in the agents list, the phone Inbox, and can be answered anywhere.
// Personas live in bots.json next to this file (created from
// bots.default.json on first edit). Faces: panel list, rooms view, floating
// dock ({dock:true}), ask dialog ({dialog:true,bot}), new-room dialog
// ({newroom:true}). Rooms ride on herdr-core: terminal labels + crew.py.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, agents, focused, run, theme, shared, setShared, openOverlay, closeOverlay, props, exec, knownAgents, readTextFile, writeTextFile, watchFolder, appHome, window, nextCommand } from "herdr";
import { launchArgv, mergeConfig, roomPrompt } from "./lib.js";

const BOTS_FILE = "mods/herd-bots/bots.json";
const DEFAULT_FILE = "mods/herd-bots/bots.default.json";
const RUNNING = "herd-bots.running"; // {tabId: botId}
const DATA = "herd-bots.config"; // {bots, agents, agentCfg, rooms, err, at}
const PREFS = "herd-bots.prefs"; // {botId: {agent, model}}
const RECENT = "herd-bots.recent"; // {agentKey: [model], newest first, max 5}
const PY = "herd-bots.py"; // {ok, roomsDir, roomlist:[...], at}
const EXTRA_ROOMS = "herd-bots.rooms.extra"; // [name] rooms with no log yet
const SEL_ROOM = "herd-bots.room"; // selected room name
const seenCmds = new Map(); // module-level dedupe: one runtime, all mounts
const ROOM_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;
let loading = false;

const crewPath = () => `${appHome()}/mods/herd-bots/crew.py`;

// Loaded once into shared() so every mount (panel, dock, dialog) renders
// synchronously. Re-reads at most once a minute. bots.json is the user's
// file; when absent the shipped bots.default.json supplies the personas,
// and its `agents`/`rooms` maps carry through either way. Agents the config
// adds that knownAgents doesn't know get a `command -v` probe once per load.
function ensureData(cx) {
  const at = shared(DATA)?.at ?? 0;
  if (loading || Date.now() - at < 60000) return;
  loading = true;
  cx.spawn(async () => {
    try {
      const data = { bots: [], agents: [], agentCfg: {}, rooms: [], err: null, at: Date.now() };
      try {
        const cfg = mergeConfig(
          await readTextFile(`${appHome()}/${DEFAULT_FILE}`),
          await readTextFile(`${appHome()}/${BOTS_FILE}`));
        data.bots = cfg.bots;
        data.agentCfg = cfg.agentCfg;
        data.rooms = cfg.rooms;
      }
      catch (e) { data.err = `${e}`; }
      try { data.agents = await knownAgents({}); } catch {}
      const known = new Set(data.agents.map(a => a.key));
      for (const [key, cfg] of Object.entries(data.agentCfg)) {
        if (known.has(key) || !cfg?.run?.length) continue;
        let installed = false;
        try { installed = (await exec("sh", ["-c", 'command -v "$0" >/dev/null', cfg.run[0]])).code === 0; } catch {}
        data.agents.push({ key, name: cfg.name ?? key, icon: null, tint: false, run: cfg.run, installed });
      }
      setShared(DATA, data);
    } finally { loading = false; }
  });
}

const data = () => shared(DATA) ?? { bots: [], agents: [], agentCfg: {}, rooms: [] };

// One python check per mount: `rooms` creates the state dir and returns the
// room list. The result (and the resolved rooms dir) live in shared(PY).
let pyChecking = false;
function ensurePy(cx) {
  const p = shared(PY);
  if (pyChecking || (p?.at && Date.now() - p.at < 60000)) return;
  pyChecking = true;
  cx.spawn(async () => {
    try {
      let roomsDir = null;
      try { roomsDir = (await exec("sh", ["-c", 'echo "${XDG_STATE_HOME:-$HOME/.local/state}/herd-bots/rooms"'])).stdout.trim(); } catch {}
      let ok = false, roomlist = [];
      try {
        const r = await exec("python3", [crewPath(), "rooms", "--json"], { timeout: 15000 });
        ok = r.code === 0;
        if (ok) roomlist = JSON.parse(r.stdout || "[]");
      } catch {}
      setShared(PY, { ok, roomsDir, roomlist, at: Date.now() });
    } finally { pyChecking = false; }
  });
}

const py = () => shared(PY) ?? { ok: null, roomlist: [] };

// Feed lines and member lists live on the view instance (shared() is
// persisted to disk — a 200-line feed must not be rewritten every refresh).
async function loadFeed(roomsDir, room) {
  const text = roomsDir ? await readTextFile(`${roomsDir}/${room}.jsonl`) : null;
  return (text ?? "").split("\n").filter(l => l.trim())
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean)
    .slice(-200);
}

async function loadWho(room) {
  try {
    const r = await exec("python3", [crewPath(), "who", room, "--json"], { timeout: 15000 });
    if (r.code === 0) return JSON.parse(r.stdout || "[]");
  } catch {}
  return [];
}

const allTabs = () => new Map(spaces().flatMap(s => (s.tabs ?? []).map(t => [t.id, { ...t, space_name: s.name, machine: s.machine }])));

async function spawnBot(bot, msg, agent, model, room) {
  const fallback = data().agents.find(a => a.installed)?.run;
  const run0 = agent?.run ?? fallback ?? (bot.agent ? [bot.agent] : ["claude"]);
  const argv = launchArgv(run0, data().agentCfg[agent?.key ?? bot.agent], model);
  const name = msg ? `${bot.name}: ${msg.slice(0, 26)}` : bot.name;
  const space = focused()?.space;
  const spaceInfo = spaces().find(s => s.id === space);
  const crew = `${appHome()}/mods/herd-bots/crew.py`;
  const prompt = room
    ? `\n\n${roomPrompt({ name: bot.name, id: bot.id, room, crew, remote: Boolean(spaceInfo?.machine) })}`
    : "";
  const task = `${bot.persona}${prompt}\n\n---\n${msg || "Say ready in one line, then wait for my instruction."}`;
  const spec = ["do", "tab.new", "--name", name, "--argv", JSON.stringify(argv), "--task", task];
  if (space) spec.push("--space", space);
  const r = await exec("herdr-app", spec);
  const out = JSON.parse(r.stdout);
  if (out.error) throw new Error(out.error);
  const live = allTabs();
  const running = Object.fromEntries(Object.entries(shared(RUNNING) ?? {}).filter(([t]) => live.has(t)));
  running[out.tab] = bot.id;
  setShared(RUNNING, running);
  if (room) {
    exec("python3", [crew, "join", room, "--bot", bot.id, "--tab", out.tab])
      .catch(e => console.log(`herd-bots join: ${e}`));
  }
}

export default class HerdBots extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.handle = cx.focus_handle();
    this.hist = false;
    this.room = null;
    this.feedCount = 0;
    if (p.dialog) {
      this.ask = InputState.new({ value: p.prefill ?? "" });
      this.ask.on("submit", (_e, cx) => this.go(cx));
      this.ask.on("focus", (_e, cx) => { this.askFocused = true; cx.notify(); });
      this.ask.on("blur", (_e, cx) => { this.askFocused = false; cx.notify(); });
      this.modelInput = InputState.new({ value: "", placeholder: "other model id" });
      this.modelInput.on("change", (_e, cx) => { this.model = this.modelInput.value().trim() || null; cx.notify(); });
      this.ask.focus();
      cx.timer.after(600, () => this.ask.focus());
      const bot = data().bots.find(b => b.id === p.bot);
      const pref = shared(PREFS)?.[p.bot];
      this.agentKey = (bot && data().agents.find(a => a.key === (pref?.agent ?? bot.agent) && a.installed)?.key)
        ?? data().agents.find(a => a.installed)?.key ?? null;
      this.model = (pref?.agent && pref.agent !== this.agentKey) ? null : (pref?.model ?? bot?.model ?? null);
      this.roomChoice = bot?.rooms?.[0] ?? data().rooms[0] ?? null;
    }
    if (p.newroom) {
      this.newroom = InputState.new({ value: "" });
      this.newroom.on("submit", (_e, cx) => this.createRoom(cx));
      this.newroom.on("focus", (_e, cx) => { this.newroomFocused = true; cx.notify(); });
      this.newroom.on("blur", (_e, cx) => { this.newroomFocused = false; cx.notify(); });
      this.newroom.focus();
      cx.timer.after(600, () => this.newroom.focus());
      this.newroomErr = null;
    }
    this.feedLines = [];
    this.members = [];
    if (!p.dialog && !p.dock && !p.newroom) {
      this.composerState();
      // Feed refresh: watch the rooms dir (once known), plus a 15s timer.
      cx.spawn(async () => {
        for (;;) {
          const dir = py().roomsDir;
          if (!dir) { await new Promise(r => cx.timer.after(500, r)); continue; }
          try { await watchFolder(dir); } catch { return; }
          await this.refreshRooms(cx);
          cx.notify();
        }
      });
      cx.timer.every(15000, (cx) => { this.composerState(); this.refreshRooms(cx); });
    }
    if (!p.dialog && !p.newroom) {
      // <mod>.<command> via run() / herdr-app do. Commands reach every
      // mounted copy. Dedupe only commands that open an overlay — one dialog,
      // not one per mount. Commands that change instance-local UI state
      // (rooms/bots switch this mount's own view) run in every copy.
      cx.spawn(async () => {
        for (;;) {
          const c = await nextCommand();
          const once = c.startsWith("ask:");
          // A sync throw here would reject this spawn and kill the command
          // loop for the mount's whole lifetime — swallow per command, and
          // un-mark so a surviving mount can still handle it.
          try {
            if (once) {
              if (seenCmds.has(c) && Date.now() - seenCmds.get(c) < 2000) continue;
              seenCmds.set(c, Date.now());
              const bot = c.slice(4);
              if (data().bots.some(b => b.id === bot))
                openOverlay({ mod: "herd-bots", kind: "dialog", width: 430, height: 620, props: { dialog: true, bot } });
            } else if (c === "rooms" || c === "bots") {
              run("layout.select", { stack: "panel-body", child: "herd-bots" });
              run("layout.show", { id: "panel" });
              localStorage.setItem("bots.view", c);
            } else if (c.startsWith("room:")) {
              const r = c.slice(5);
              if (ROOM_RE.test(r)) { setShared(SEL_ROOM, r); this.room = null; this.feedCount = -1; this.lastLoad = 0; localStorage.setItem("bots.view", "rooms"); }
            } else if (c.startsWith("delroom:")) {
              // Drop an extra room (one with no log yet). Logged rooms stay:
              // deleting history is a filesystem op, not a view op.
              const r = c.slice(8);
              if (ROOM_RE.test(r)) {
                const extra = (shared(EXTRA_ROOMS) ?? []).filter(x => x !== r);
                if (extra.length !== (shared(EXTRA_ROOMS) ?? []).length) setShared(EXTRA_ROOMS, extra);
                if ((shared(SEL_ROOM) ?? "general") === r) setShared(SEL_ROOM, this.roomList()[0] ?? "general");
              }
            } else if (c === "hist") {
              this.hist = !this.hist;
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
    }
    ensureData(cx);
    ensurePy(cx);
  }

  composerState() {
    const want = `Message #${this.selRoom() ?? "room"}   @bot to reach one, @all for everyone`;
    if (!this.composer || this.composerPh !== want) {
      const value = this.composer?.value() ?? "";
      this.composerPh = want;
      this.composer = InputState.new({ value, placeholder: want });
      this.composer.on("submit", (_e, cx) => this.post(cx));
      this.composer.on("focus", (_e, cx) => { this.composerFocused = true; cx.notify(); });
      this.composer.on("blur", (_e, cx) => { this.composerFocused = false; cx.notify(); });
    }
    return this.composer;
  }

  async refreshRooms(cx) {
    const room = this.selRoom();
    if (py().roomsDir && room && Date.now() - (this.lastLoad ?? 0) > 3000) {
      this.lastLoad = Date.now();
      this.feedLines = await loadFeed(py().roomsDir, room);
      this.members = await loadWho(room);
    }
    const n = this.feedLines.length;
    if (n !== this.feedCount) { this.feedCount = n; this.hist = false; cx.notify(); }
  }

  // The shown view lives in localStorage, read on every render: same-context
  // mounts share it, so a copy that was hidden when "rooms"/"bots" arrived
  // still picks it up, and each JS context (panel, kept window) keeps its own.
  activeView() { return localStorage.getItem("bots.view") ?? "bots"; }

  setView(v, cx) {
    localStorage.setItem("bots.view", v);
    cx.notify();
  }

  selRoom() {
    const rooms = this.roomList();
    const want = this.room ?? shared(SEL_ROOM);
    return want && rooms.includes(want) ? want : (rooms[0] ?? null);
  }

  roomList() {
    const cfg = data().rooms ?? [];
    const logged = py().roomlist ?? [];
    const extra = (shared(EXTRA_ROOMS) ?? []).filter(r => !logged.includes(r));
    if (extra.length !== (shared(EXTRA_ROOMS) ?? []).length) setShared(EXTRA_ROOMS, extra);
    return [...new Set([...cfg, ...logged, ...extra])];
  }

  glyph(bot, size) {
    return div().size(size).rounded(Math.round(size / 3.4)).bg((bot.color ?? "#57e7c1") + "22")
      .border_1().border_color((bot.color ?? "#57e7c1") + "66")
      .flex().items_center().justify_center().flex_none()
      .text_size(size * 0.52).font_semibold().text_color(bot.color ?? "#57e7c1")
      .child(bot.glyph ?? bot.name?.[0] ?? "?");
  }

  // Jump to a bot's first live tab (right-click on glyph or card).
  focusRunning(live) {
    if (!live.length) return;
    const agent = agents().find(a => a.tab === live[0].tab);
    if (agent) run("agent.focus", { terminal: agent.address });
    else run("tab.select", { id: live[0].tab });
  }

  runningBots() {
    const tabs = allTabs();
    return Object.entries(shared(RUNNING) ?? {})
      .filter(([tab]) => tabs.has(tab))
      .map(([tab, bot]) => ({ tab, bot }));
  }

  // ---- dock: the floating chip strip ----
  dock(t, running, bots) {
    return h_flex().px(9).py(7).gap(8).items_center()
      .when(bots.length === 0, el => el.child(
        h_flex().id("dock-empty").h(30).px(10).gap(6).items_center().rounded(8).bg(t.raised).border_1().border_color(t.border)
          .text_size(11).text_color(t.dim).cursor_pointer()
          .on_click(() => { run("layout.select", { stack: "panel-body", child: "herd-bots" }); run("layout.show", { id: "panel" }); })
          .child(svg("mods/herd-bots/bot.svg").size(13))
          .child("Bots")))
      .children(bots.map(bot => {
        const live = running.filter(r => r.bot === bot.id);
        return div().id(`dock-${bot.id}`).relative().cursor_pointer().tooltip(`${bot.name} — ${bot.tag ?? ""}${live.length ? " · right-click jumps to it" : ""}`)
          .on_click(() => openOverlay({ mod: "herd-bots", kind: "dialog", width: 430, height: 500, props: { dialog: true, bot: bot.id } }))
          .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.focusRunning(live); })
          .child(this.glyph(bot, 30))
          .when(live.length > 0, el => el.child(div().absolute().top(-3).right(-3).size(10).rounded_full().bg(t.working).border_1().border_color(t.canvas)));
      }));
  }

  go(cx) {
    const p = props() ?? {};
    const bot = data().bots.find(b => b.id === p.bot);
    if (!bot) return;
    const agent = data().agents.find(a => a.key === this.agentKey);
    const msg = this.ask.value().trim();
    const model = this.modelInput?.value().trim() || this.model;
    const room = this.roomChoice;
    // remember the choice for next time; a non-default model feeds recents
    setShared(PREFS, { ...(shared(PREFS) ?? {}), [bot.id]: { agent: this.agentKey, model } });
    if (model && this.agentKey) {
      const r = shared(RECENT) ?? {};
      r[this.agentKey] = [model, ...(r[this.agentKey] ?? []).filter(m => m !== model)].slice(0, 5);
      setShared(RECENT, r);
    }
    closeOverlay(p.overlay);
    cx.spawn(async () => {
      try { await spawnBot(bot, msg, agent, model, room); }
      catch (e) { console.log(`herd-bots spawn: ${e.message}`); }
    });
  }

  agentChip(t, a) {
    return h_flex().id(`pk-${a.key}`).h(24).px(8).mr(6).items_center().gap(5).rounded(6).flex_none()
      .border_1().border_color(this.agentKey === a.key ? t.accent : t.input).bg(this.agentKey === a.key ? t.accent + "1f" : t.raised)
      .text_color(this.agentKey === a.key ? t.accent : t.muted).text_size(11).cursor_pointer()
      .hover(s => s.text_color(t.foreground)).on_click(() => { this.agentKey = a.key; this.model = null; this.modelInput?.set_value?.(""); })
      .child(a.icon
        ? (a.tint ? svg(a.icon).size(12).text_color(this.agentKey === a.key ? t.accent : t.muted) : image(a.icon).size(12))
        : div().size(12).rounded(3).bg(t.surface).border_1().border_color(t.input).flex().items_center().justify_center()
          .text_size(8).font_semibold().text_color(this.agentKey === a.key ? t.accent : t.muted).child((a.name ?? a.key)[0].toUpperCase()))
      .child(a.name);
  }

  // ---- ask dialog ----
  dialog(t, d) {
    const p = props() ?? {};
    const bot = d.bots.find(b => b.id === p.bot);
    if (!bot) return v_flex().p(18).bg(t.popover).child(div().text_color(t.muted).child(d.err ? `bots.json: ${d.err}` : "Loading…"));
    const close = () => closeOverlay(p.overlay);
    const installed = d.agents.filter(a => a.installed);
    const go = (cx) => this.go(cx);
    const cfg = d.agentCfg[this.agentKey] ?? {};
    const showModel = Boolean(cfg.model_flag);
    const recents = (shared(RECENT)?.[this.agentKey] ?? []).filter(m => !(cfg.models ?? []).includes(m)).slice(0, 3);
    const rooms = d.rooms ?? [];
    const modelChip = (id, label, value) => h_flex().id(id).h(24).px(8).mr(6).items_center().rounded(6).flex_none()
      .border_1().border_color(this.model === value && !this.modelInput?.value().trim() ? t.accent : t.input)
      .bg(this.model === value && !this.modelInput?.value().trim() ? t.accent + "1f" : t.raised)
      .text_color(this.model === value && !this.modelInput?.value().trim() ? t.accent : t.muted).text_size(11).cursor_pointer()
      .hover(s => s.text_color(t.foreground))
      .on_click((_e, cx) => { this.model = value; this.modelInput.set_value(""); cx.notify(); })
      .child(label);
    const roomChip = (id, label, value) => h_flex().id(id).h(24).px(8).mr(6).items_center().rounded(6).flex_none()
      .border_1().border_color(this.roomChoice === value ? t.accent : t.input)
      .bg(this.roomChoice === value ? t.accent + "1f" : t.raised)
      .text_color(this.roomChoice === value ? t.accent : t.muted).text_size(11).cursor_pointer()
      .hover(s => s.text_color(t.foreground))
      .on_click((_e, cx) => { this.roomChoice = value; cx.notify(); })
      .child(label);
    return v_flex().id("hb-dialog").track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape") { close(); cx.stop_propagation(); } })
      .w_full().min_h(0).p(18).bg(t.popover).text_color(t.foreground).text_size(12.8)
      .child(h_flex().flex_none().gap(10).items_center()
        .child(this.glyph(bot, 34))
        .child(v_flex().flex_1().min_w(0)
          .child(div().text_size(15).font_semibold().child(bot.name))
          .child(div().text_size(11).text_color(t.dim).truncate().child(bot.tag ?? "")))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(div().flex_none().mt(12).p(10).rounded(9).bg(t.background).border_1().border_color(t.border).h(110).overflow_y_scrollbar()
        .child(div().text_size(11).text_color(t.dim).child(bot.persona)))
      .child(div().flex_none().pt(12).pb(6).text_size(11).text_color(t.dim).child(`Ask ${bot.name}`))
      .child(Input.new(this.ask).h(36).px(10).rounded(9).border_1().border_color(this.askFocused ? t.accent : t.input).bg(t.background).text_color(t.foreground))
      .child(div().flex_none().pt(12).pb(6).text_size(11).text_color(t.dim).child("Run on"))
      .child(h_flex().h(26).items_center().overflow_x_scrollbar().flex_none().children(installed.map(a => this.agentChip(t, a))))
      .when(showModel, el => el
        .child(div().flex_none().pt(12).pb(6).text_size(11).text_color(t.dim).child("Model"))
        .child(h_flex().items_center().overflow_x_scrollbar().flex_none()
          .child(modelChip("md-default", "Default", null))
          .children((cfg.models ?? []).map(m => modelChip(`md-${m}`, m, m)))
          .children(recents.map(m => modelChip(`mdr-${m}`, m, m)))
          .child(Input.new(this.modelInput).h(26).w(140).px(8).ml(2).rounded(6).border_1()
            .border_color(this.modelInput?.value().trim() ? t.accent : t.input).bg(t.background)
            .text_color(t.foreground).text_size(11))))
      .when(py().ok !== false && rooms.length > 0, el => el
        .child(div().flex_none().pt(12).pb(6).text_size(11).text_color(t.dim).child("Room"))
        .child(h_flex().items_center().overflow_x_scrollbar().flex_none()
          .children(rooms.map(r => roomChip(`rm-${r}`, `#${r}`, r)))
          .child(roomChip("rm-none", "none", null))))
      .child(div().flex_1())
      .child(h_flex().flex_none().pt(16).gap(8).justify_end()
        .child(h_flex().id("hb-cancel").h(32).px(14).items_center().rounded(8).border_1().border_color(t.input).bg(t.raised).text_size(12.5).cursor_pointer().hover(s => s.opacity(0.85)).on_click(close).child("Cancel"))
        .child(h_flex().id("hb-go").h(32).px(14).items_center().rounded(8).bg(installed.length ? t.solid : t.raised).text_color(installed.length ? t.solid_foreground : t.dim).text_size(12.5).font_medium().cursor_pointer()
          .when(installed.length > 0, el => el.hover(s => s.opacity(0.88)).on_click(go))
          .tooltip(installed.length ? "Launch this persona as an agent tab" : "No agent CLIs detected")
          .child("Start bot")));
  }

  // ---- new-room dialog ----
  createRoom(cx) {
    const name = this.newroom.value().trim();
    if (!ROOM_RE.test(name)) {
      this.newroomErr = "lowercase letters, digits and dashes, 1-24 chars";
      cx.notify();
      return;
    }
    const p = py();
    if (!(p.roomlist ?? []).includes(name) && !(shared(EXTRA_ROOMS) ?? []).includes(name))
      setShared(EXTRA_ROOMS, [...(shared(EXTRA_ROOMS) ?? []), name]);
    setShared(SEL_ROOM, name);
    closeOverlay(props()?.overlay);
    cx.notify();
  }

  newroomDialog(t) {
    const p = props() ?? {};
    const close = () => closeOverlay(p.overlay);
    return v_flex().id("hb-newroom").track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape") { close(); cx.stop_propagation(); } })
      .w_full().min_h(0).p(18).bg(t.popover).text_color(t.foreground).text_size(12.8)
      .child(h_flex().flex_none().items_center().child(div().flex_1().text_size(15).font_semibold().child("New room"))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(div().flex_none().pt(12).pb(6).text_size(11).text_color(t.dim).child("Name"))
      .child(Input.new(this.newroom).h(36).px(10).rounded(9).border_1()
        .border_color(this.newroomFocused ? t.accent : t.input).bg(t.background).text_color(t.foreground))
      .when(this.newroomErr, el => el.child(div().flex_none().pt(6).text_size(11).text_color(t.blocked).child(this.newroomErr)))
      .child(div().flex_1())
      .child(h_flex().flex_none().pt(16).gap(8).justify_end()
        .child(h_flex().h(32).px(14).items_center().rounded(8).border_1().border_color(t.input).bg(t.raised).text_size(12.5).cursor_pointer().hover(s => s.opacity(0.85)).on_click(close).child("Cancel"))
        .child(h_flex().id("hb-room-create").h(32).px(14).items_center().rounded(8).bg(t.solid).text_color(t.solid_foreground).text_size(12.5).font_medium().cursor_pointer().hover(s => s.opacity(0.88))
          .on_click((_e, cx) => this.createRoom(cx)).child("Create")));
  }

  post(cx) {
    const room = this.selRoom();
    const text = this.composer.value().trim();
    if (!room || !text) return;
    this.composer.set_value("");
    this.composer.focus();
    this.hist = false;
    cx.spawn(async () => {
      try {
        await exec("python3", [crewPath(), "post", room, text, "--from", "you"]);
        this.feedLines = await loadFeed(py().roomsDir, room);
        this.feedCount = this.feedLines.length;
      } catch (e) { console.log(`herd-bots post: ${e}`); }
      cx.notify();
    });
  }

  // ---- rooms view ----
  roomsView(t, running) {
    const p = py();
    if (p.ok === false) {
      return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
        .child(div().px(16).py(14).text_size(12).text_color(t.dim).child("Rooms need python3 on this machine."));
    }
    const rooms = this.roomList();
    const room = this.selRoom();
    const feed = { lines: this.feedLines };
    const who = this.members;
    const inRoom = new Set(who.map(m => (m.bot ?? "").toLowerCase()));
    const byBot = new Map(who.filter(m => m.bot).map(m => [m.bot, m.terminal]));
    const tabs = allTabs();
    const botsById = new Map(data().bots.map(b => [b.id, b]));
    const seen = new Set();
    const members = running.filter(r => !seen.has(r.bot) && seen.add(r.bot));

    const roomChip = (r, filled) => h_flex().id(`rc-${r}`).h(24).px(9).mr(6).items_center().rounded(6).flex_none()
      .border_1().border_color(filled ? t.accent : t.input).bg(filled ? t.accent + "1f" : t.raised)
      .text_color(filled ? t.accent : t.muted).text_size(11).cursor_pointer()
      .hover(s => s.text_color(t.foreground))
      .on_click((_e, cx) => { this.room = r; setShared(SEL_ROOM, r); this.feedCount = -1; this.composerState(); this.refreshRooms(cx); cx.notify(); })
      .child(`#${r}`);

    const memberGlyph = (m) => {
      const bot = botsById.get(m.bot) ?? { id: m.bot, name: m.bot, glyph: m.bot[0] };
      const inside = inRoom.has(m.bot.toLowerCase());
      return div().id(`mem-${m.bot}`).flex_none().opacity(inside ? 1 : 0.35).cursor_pointer()
        .tooltip(`${bot.name} — ${inside ? "click: @mention · right-click: leave" : "click: join #" + room}`)
        .on_click((_e, cx) => {
          if (inside) {
            this.composer.set_value(`${this.composer.value()}@${m.bot} `);
            this.composer.focus();
          } else {
            cx.spawn(async () => {
              try { await exec("python3", [crewPath(), "join", room, "--bot", m.bot, "--tab", m.tab]); await loadWho(room); }
              catch (e) { console.log(`herd-bots join: ${e}`); }
              cx.notify();
            });
          }
        })
        .on_mouse_down("right", (_e, cx) => {
          cx.stop_propagation();
          const addr = byBot.get(m.bot);
          if (!inside || !addr) return;
          cx.spawn(async () => {
            try { await exec("python3", [crewPath(), "leave", room, "--terminal", addr]); await loadWho(room); }
            catch (e) { console.log(`herd-bots leave: ${e}`); }
            cx.notify();
          });
        })
        .child(this.glyph(bot, 22));
    };

    const lineView = (l, i) => {
      const bot = botsById.get(l.from);
      const ts = new Date(l.ts ?? 0);
      const hhmm = `${String(ts.getHours()).padStart(2, "0")}:${String(ts.getMinutes()).padStart(2, "0")}`;
      const sender = l.from === "you"
        ? div().size(22).rounded(6).bg(t.accent + "22").border_1().border_color(t.accent + "66").flex().items_center().justify_center().flex_none()
          .text_size(9).font_semibold().text_color(t.accent).child("you")
        : this.glyph(bot ?? { name: l.from, glyph: l.from?.[0] ?? "?" }, 22);
      const notes = [];
      for (const m of l.missed ?? []) {
        notes.push(h_flex().gap(5).items_center().flex_none()
          .child(div().text_color(t.dim).child(`not delivered to @${m.bot}: ${m.reason}`))
          .when(botsById.has(m.bot), el => el.child(
            div().text_color(t.accent).underline().child("start"))));
      }
      if (l.held === "rate") notes.push(div().text_color(t.dim).child("held: too many bot messages this minute"));
      return h_flex().flex_none().px(12).py(5).gap(8).items_start()
        .child(sender)
        .child(v_flex().flex_1().min_w(0).gap(1)
          .child(h_flex().gap(7).items_center()
            .child(div().text_size(11.5).font_medium().text_color(l.from === "you" ? t.accent : t.foreground).child(l.from))
            .child(div().text_size(10).text_color(t.dim).child(hhmm)))
          .child(div().text_size(12).text_color(t.muted).child(l.text))
          .children(notes.map(n => div().pt(2).text_size(10.5).child(n))));
    };

    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(h_flex().flex_none().px(14).h(40).items_center().overflow_x_scrollbar()
        .children(rooms.map(r => roomChip(r, r === room)))
        .child(h_flex().id("room-add").h(24).w(24).items_center().justify_center().rounded(6).flex_none()
          .border_1().border_color(t.input).text_color(t.dim).text_size(11).cursor_pointer()
          .hover(s => s.bg(t.hover).text_color(t.foreground)).tooltip("New room")
          .on_click(() => openOverlay({ mod: "herd-bots", kind: "dialog", width: 380, height: 210, props: { newroom: true } }))
          .child("+")))
      .child(h_flex().flex_none().h(36).px(14).gap(7).items_center().border_b(1).border_color(t.border)
        .children(members.map(memberGlyph))
        .when(members.length === 0, el => el.child(
          div().text_size(11).text_color(t.dim).child("No bots running. Start one from Bots."))))
      .child(v_flex().flex_1().min_h(0)
        .when(feed.lines.length > 0, el => this.hist
          ? el
            .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar()
              .children(feed.lines.slice(-200).map(lineView)))
            .child(div().flex_none().px(12).py(6)
              .child(h_flex().id("back-latest").h(24).px(9).items_center().rounded(6)
                .border_1().border_color(t.input).bg(t.raised).text_color(t.muted).text_size(11).cursor_pointer()
                .hover(s => s.text_color(t.foreground))
                .on_click((_e, cx) => { this.hist = false; cx.notify(); })
                .child("Back to latest")))
          : el
            .child(v_flex().flex_1().min_h(0).justify_end().overflow_hidden()
              .children(feed.lines.slice(-40).map(lineView)))
            .when(feed.lines.length > 40, e => e.child(div().flex_none().px(12).pt(2).pb(4)
              .child(h_flex().id("earlier").h(24).px(9).items_center().rounded(6)
                .border_1().border_color(t.input).bg(t.raised).text_color(t.muted).text_size(11).cursor_pointer()
                .hover(s => s.text_color(t.foreground))
                .on_click((_e, cx) => { this.hist = true; cx.notify(); })
                .child("Earlier messages")))))
        .when(feed.lines.length === 0, el => el.child(
          div().px(16).py(14).text_size(12).text_color(t.dim)
            .child(`No messages in #${room} yet. Start a bot in this room, then @mention it.`))))
      .child(h_flex().flex_none().px(12).h(44).items_center().border_t(1).border_color(t.border)
        .child(Input.new(this.composer).flex_1().h(30).px(10).rounded(8).border_1()
          .border_color(this.composerFocused ? t.accent : t.input).bg(t.background).text_color(t.foreground).text_size(12)));
  }

  // ---- panel: the card list ----
  panel(t, running, tabs, d) {
    const prefs = shared(PREFS) ?? {};
    const card = (bot) => {
      const live = running.filter(r => r.bot === bot.id);
      const wants = d.agents.find(a => a.key === bot.agent);
      const missing = bot.agent && d.agents.length > 0 && !wants?.installed;
      const pref = prefs[bot.id];
      const sel = pref?.agent
        ? ` · ${pref.agent}${pref.model ? ` · ${pref.model}` : ""}`
        : bot.model ? ` · ${bot.agent ?? ""} · ${bot.model}` : "";
      return h_flex().id(`bot-${bot.id}`).flex_none().mx(10).mb(6).px(10).py(9).rounded(10).bg(t.raised).border_1().border_color(t.border)
        .gap(10).items_center().cursor_pointer().hover(s => s.border_color(t.input))
        .on_click(() => openOverlay({ mod: "herd-bots", kind: "dialog", width: 430, height: 500, props: { dialog: true, bot: bot.id } }))
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.focusRunning(live); })
        .child(this.glyph(bot, 34))
        .child(v_flex().flex_1().min_w(0).gap(1)
          .child(div().truncate().font_medium().text_size(12.5).text_color(t.foreground).child(bot.name))
          .child(div().truncate().text_size(11).text_color(t.dim).child(missing ? `needs ${bot.agent}` : `${bot.tag ?? ""}${sel}`)))
        .when(live.length > 0, el => el.child(
          h_flex().id(`live-${bot.id}`).h(20).px(7).gap(5).items_center().rounded(6).bg(t.working + "1f").text_color(t.working).text_size(10.5).font_medium().cursor_pointer()
            .tooltip("Jump to this bot's tab")
            .on_click((_e, cx) => { cx.stop_propagation(); this.focusRunning(live); })
            .child(div().size(5).rounded(3).bg(t.working))
            .child(String(live.length))));
    };
    return v_flex().flex_1().min_h(0).overflow_y_scrollbar().pt(10)
      .children(d.bots.map(card))
      .when(d.bots.length === 0, el => el.child(div().flex_none().px(16).py(14).text_size(12).text_color(t.dim)
        .child(d.err ? `Could not read bots.json: ${d.err}` : "No bots yet — add some to bots.json.")));
  }

  render(cx) {
    const t = theme();
    const p = props() ?? {};
    ensureData(cx);
    ensurePy(cx);
    if (p.dialog) return this.dialog(t, data());
    if (p.newroom) return this.newroomDialog(t);
    if (p.dock) return this.dock(t, this.runningBots(), data().bots);
    const roomsMode = this.activeView() === "rooms";
    if (roomsMode) this.refreshRooms(cx);
    const curView = this.activeView();
    const seg = (id, label) => div().id(`seg-${id}`).h(24).px(10).rounded(6).flex().items_center().cursor_pointer()
      .text_size(11).text_color(curView === id ? t.foreground : t.dim)
      .bg(curView === id ? t.selected : "#00000000")
      .hover(s => s.text_color(t.foreground))
      .on_click((_e, cx) => this.setView(id, cx))
      .child(label);
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(h_flex().px(14).h(44).flex_none().items_center().gap(8).border_b(1).border_color(t.border)
        .child(seg("bots", "Bots"))
        .child(seg("rooms", "Rooms"))
        .child(div().flex_1())
        .when(!roomsMode, el => el.child(
          div().id("hb-edit").h(24).px(8).rounded(6).text_size(11).text_color(t.dim).flex().items_center().cursor_pointer()
            .hover(s => s.bg(t.hover).text_color(t.foreground)).tooltip(`Edit ${BOTS_FILE}`)
            .on_click((_e, cx) => cx.spawn(async () => {
              const path = `${appHome()}/${BOTS_FILE}`;
              try {
                if ((await readTextFile(path)) === null) {
                  const def = (await readTextFile(`${appHome()}/${DEFAULT_FILE}`)) ?? "{}\n";
                  await writeTextFile(path, def, null);
                }
                await exec(window()?.platform === "macos" ? "open" : "xdg-open", window()?.platform === "macos" ? ["-t", path] : [path]);
              }
              catch (e) { console.log(`herd-bots open: ${e}`); }
            })
            .child("Edit personas"))))
        .when(p.overlay, el => el.child(
          div().id("hb-close").size(22).rounded(6).flex_none().flex().items_center().justify_center().cursor_pointer()
            .hover(s => s.bg(t.hover)).tooltip("Close")
            .on_click(() => closeOverlay(p.overlay))
            .child(svg("mods/pane/close.svg").size(12).text_color(t.muted)))))
      .child(roomsMode ? this.roomsView(t, this.runningBots()) : this.panel(t, this.runningBots(), allTabs(), data()));
  }
}
