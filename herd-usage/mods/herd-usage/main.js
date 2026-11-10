// herd-usage: token usage stats read from each agent CLI's own records via
// usage.py (frozen collector). shared("herd-usage.doc") is the single render
// source for every mount context — kept windows are separate JS runtimes, so
// module memory can't be. Mounts never run the collector themselves: they ask
// for a reload by bumping shared("herd-usage.refresh") and a stable mount
// (abyss-status in the abyss layout) does the exec and writes doc + meta.
// As a fallback, a non-overlay mount collects itself when no loader ever
// answers (standalone installs without the abyss status bar). Only the small
// shared("herd-usage.summary") goes to status-bar chips.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, theme, shared, setShared, exec, appHome, props, nextCommand, closeOverlay } from "herdr";
import { fmt, tokens, cached, pick, rangeDays, ranked, resetsIn, money, ago, windowLabel, agentDaily } from "./lib.js";

const DOC = "herd-usage.doc"; // the full usage document
const META = "herd-usage.meta"; // {at, since?, loading, error}
const REFRESH = "herd-usage.refresh"; // ms of the last reload request
const SUMMARY = "herd-usage.summary"; // {at, today, d7} for status chips
const RANGES = [["today", "Today"], ["d7", "7 days"], ["window", "30 days"]];
const STALE = 5 * 60000; // doc older than this is reloaded
const LOADING_LEEWAY = 90 * 1000; // a meta.loading this old is treated as dead
const AGENT_COLOR = { claude: "ansi4", codex: "ansi2", opencode: "ansi6", devin: "ansi5", goose: "ansi3", amp: "ansi1" };
const colorOf = (t, key) => t[AGENT_COLOR[key]] ?? t.accent;

const meta = () => shared(META) ?? {};
const doc = () => shared(DOC);
const isLoading = () => meta().loading === true && Date.now() - (meta().since ?? meta().at ?? 0) < LOADING_LEEWAY;

let lastFlag = 0, firstAsk = 0, selfLoading = false;

// Ask the loader for a reload. Refresh presses pass force; otherwise only a
// missing or stale document asks. Coalesced to one flag write every 3s.
function ask(force = false) {
  if (isLoading()) return;
  const m = meta(), d = doc();
  const fresh = m.at && Date.now() - m.at <= (d ? STALE : 60000);
  if (!force && fresh) return;
  const now = Date.now();
  if (now - lastFlag < 3000) return;
  lastFlag = now;
  if (!firstAsk) firstAsk = now;
  setShared(REFRESH, now);
}

// Fallback for installs without a loader mount: a panel mount collects the
// document itself, writing the same shared keys. Overlay mounts never get
// here — kept windows can't rely on exec resolving in their runtime.
function selfLoad(cx) {
  if (selfLoading) return;
  selfLoading = true;
  cx.spawn(async () => {
    setShared(META, { ...meta(), since: Date.now(), loading: true });
    try {
      const r = await exec("python3", [`${appHome()}/mods/herd-usage/usage.py`, "--days", "30"], { timeout: 30000 });
      if (r.code !== 0) throw new Error(r.stderr.split("\n").find(l => l.trim()) ?? "usage.py failed");
      const d = JSON.parse(r.stdout);
      const now = Date.now();
      setShared(DOC, d);
      setShared(SUMMARY, { at: now, today: tokens(pick(d.totals, "today")), d7: tokens(pick(d.totals, "d7")) });
      setShared(META, { at: now, loading: false, error: null });
    } catch (e) {
      setShared(META, { at: Date.now(), loading: false, error: `${e}` });
    } finally { selfLoading = false; }
  });
}

// Every mount asks for data it needs; a non-overlay mount that has asked for
// ~8s without any meta ever appearing concludes there's no loader and does
// the collection itself. An error older than a minute also counts as
// loader-less so a standalone panel retries on a slow backoff.
function want(cx, force = false) {
  ask(force);
  if (props()?.overlay || !firstAsk || selfLoading || isLoading()) return;
  const m = meta();
  const noLoader = (!m.at && !m.error) || (m.error && Date.now() - (m.at ?? 0) > 60000);
  if (noLoader && Date.now() - firstAsk > 8000) selfLoad(cx);
}

const R = (t) => ({ acc: t.accent, dim: t.dim, mut: t.muted, fg: t.foreground, err: t.ansi1 ?? t.blocked });

// one stacked bar per day; days outside the range are dimmed
function bars(t, rows, inRange, h, perAgent) {
  const max = Math.max(1, ...rows.map(r => tokens(r.p ?? r)));
  return h_flex().h(h).gap(2).items_end().flex_none()
    .children(rows.map((r, i) => {
      const parts = perAgent ? r.parts : [{ v: tokens(r.p ?? r), c: t.accent }];
      const hpx = Math.max(parts.reduce((s, x) => s + x.v, 0) > 0 ? 2 : 0, Math.round((h - 6) * parts.reduce((s, x) => s + x.v, 0) / max));
      const tips = r.tooltip;
      return v_flex().flex_1().h(h).items_end().opacity(inRange(i, r) ? 1 : 0.35)
        .when(tips, el => el.tooltip(tips))
        .child(v_flex().h(hpx).w_full().gap(0)
          .children(parts.map(pt => div().flex_1().min_h(pt.v > 0 ? 1 : 0).rounded(1).bg(pt.c))));
    }));
}

function statCol(t, label, value) {
  return v_flex().flex_1().min_w(0).gap(1)
    .child(div().text_size(9.5).text_color(t.dim).child(label))
    .child(div().truncate().text_size(11.5).font_medium().text_color(t.muted).child(value));
}

export default class HerdUsage extends View {
  init(_props, cx) {
    this.range = localStorage.getItem("usage.range") ?? "d7";
    this.expanded = null;
    cx.spawn(async () => {
      for (;;) {
        const c = await nextCommand();
        // No dedupe: every command here is instance-local state (a range
        // chip) or a shared flag bump the loader coalesces anyway. A sync
        // throw would reject this spawn and kill the loop — swallow it.
        try {
          if (c === "refresh") want(cx, true);
          // Every mount sees "close"; only the kept-window mount (the one with
          // props().overlay) acts — panels/panes no-op.
          else if (c === "close") { if (props().overlay) closeOverlay(props().overlay); }
          else if (c.startsWith("range:")) {
            this.range = c.slice(6);
            localStorage.setItem("usage.range", this.range);
          }
        } catch {}
        cx.notify();
      }
    });
    cx.timer.every(60000, (cx) => want(cx));
    want(cx);
  }

  rangeChip(t, id, label) {
    return div().id(`ur-${id}`).h(24).px(9).rounded(6).flex().items_center().cursor_pointer().flex_none()
      .text_size(11).text_color(this.range === id ? t.foreground : t.dim)
      .bg(this.range === id ? t.selected : "#00000000").hover(s => s.text_color(t.foreground))
      .on_click((_e, cx) => { this.range = id; localStorage.setItem("usage.range", id); cx.notify(); }).child(label);
  }

  agentCard(t, entry, agentSeries, rangeDates) {
    const { agent, p, share } = entry;
    const c = colorOf(t, agent.key);
    const open = this.expanded === agent.key;
    const inR = new Set(rangeDates);
    const lim = agent.limits;
    const rows = agentSeries.map(d => ({ parts: [{ v: tokens(d.p), c }], tooltip: `${d.date} · ${fmt(tokens(d.p))}`, date: d.date }));
    return v_flex().id(`ua-${agent.key}`).flex_none().mx(10).mb(6).px(10).py(8).rounded(10).bg(t.raised)
      .border_1().border_color(t.border).gap(5).cursor_pointer()
      .hover(s => s.border_color(t.input))
      .on_click((_e, cx) => { this.expanded = open ? null : agent.key; cx.notify(); })
      .child(h_flex().gap(7).items_center()
        .child(div().size(7).rounded_full().bg(c))
        .child(div().flex_1().min_w(0).truncate().font_medium().text_size(12.5).text_color(t.foreground).child(agent.name ?? agent.key))
        .child(div().text_size(12).font_medium().text_color(t.foreground).child(fmt(tokens(p))))
        .child(div().w(36).text_size(10).text_color(t.dim).child(`${Math.round(share * 100)}%`)))
      .child(div().h(3).rounded(2).bg(t.surface).child(div().h(3).rounded(2).w(`${Math.round(share * 100)}%`).max_w_full().bg(c)))
      .child(div().truncate().text_size(10.5).text_color(t.dim)
        .child(`in ${fmt(p.in)} · out ${fmt(p.out)} · cached ${fmt(cached(p))} · ${p.sessions ?? 0} sessions`))
      .child(bars(t, rows, (i, r) => inR.has(r.date), 20, true))
      .when(Boolean(lim), el => el
        .child(div().h(3).rounded(2).bg(t.surface).child(div().h(3).rounded(2).w(`${Math.min(100, lim.used_percent ?? 0)}%`).bg(t.ansi3 ?? t.accent)))
        .child(div().text_size(10.5).text_color(t.dim)
          .child(`${lim.used_percent}% of the ${windowLabel(lim.window_minutes)} limit used${lim.plan ? ` · plan ${lim.plan}` : ""}${lim.resets_at ? ` · resets in ${resetsIn(lim.resets_at, Date.now())}` : ""} · as of ${ago(lim.as_of, Date.now())}`)))
      .when(Boolean(agent.note), el => el.child(div().text_size(10.5).text_color(t.dim).child(agent.note)))
      .when(Boolean(agent.error), el => el.child(div().text_size(10.5).text_color(t.ansi1 ?? t.blocked)
        .child(`Could not read ${agent.name ?? agent.key}'s records: ${agent.error}`)))
      .when(open, el => el.children((agent.models ?? []).slice(0, 8).map(m => {
        const ms = tokens(m) / Math.max(1, tokens(p));
        return v_flex().gap(1).pt(2)
          .child(h_flex().gap(7).items_center()
            .child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.muted).child(m.model ?? "?"))
            .child(div().text_size(10.5).text_color(t.dim).child(fmt(tokens(m)))))
          .child(div().h(2).rounded(1).bg(t.surface).child(div().h(2).rounded(1).w(`${Math.round(ms * 100)}%`).bg(c)));
      })));
  }

  render(cx) {
    // A throw here bricks the mount (frozen frame, dead clicks) — show an
    // error strip instead so a transient bad state can't take it down.
    try {
      return this.renderBody(cx);
    } catch (e) {
      const t = theme();
      return div().size_full().p(10).text_size(11).text_color(t.muted)
        .child(`herd-usage render error: ${e}`);
    }
  }

  renderBody(cx) {
    const t = theme();
    want(cx);
    const d = doc(), m = meta(), loading = isLoading();
    const live = agents();
    const nWork = live.filter(a => a.status === "working").length;
    const nBlock = live.filter(a => a.status === "blocked").length;
    const nIdle = live.length - nWork - nBlock;
    const dot = (color) => div().size(6).rounded_full().bg(color);
    const head = h_flex().px(14).h(44).flex_none().items_center().gap(7).border_b(1).border_color(t.border)
      .child(div().flex_1().text_size(13).font_semibold().child("Usage"))
      .children(RANGES.map(([id, label]) => this.rangeChip(t, id, label)))
      .child(div().id("u-refresh").size(24).rounded(6).flex().items_center().justify_center().cursor_pointer()
        .hover(s => s.bg(t.hover)).tooltip(m.at ? `Updated ${ago(m.at, Date.now())}` : "Refresh")
        .on_click((_e, cx) => { want(cx, true); cx.notify(); })
        .child(svg("mods/workspace-chrome/spinner.svg").size(13).text_color(t.dim).when(loading, el => el.spin(900))))
      .when((props() ?? {}).overlay, el => el.child(
        div().id("u-close").size(22).rounded(6).flex_none().flex().items_center().justify_center().cursor_pointer()
          .hover(s => s.bg(t.hover)).tooltip("Close")
          .on_click(() => closeOverlay((props() ?? {}).overlay))
          .child(svg("mods/pane/close.svg").size(12).text_color(t.muted))));
    if (!d) {
      const waiting = !loading && !m.error && firstAsk && Date.now() - firstAsk > 8000;
      return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
        .child(head)
        .child(div().p(16).text_size(12).text_color(t.dim).child(m.error ? m.error : "Reading usage…"))
        .when(waiting, el => el.child(div().px(16).pb(14).text_size(11).text_color(t.dim)
          .child("Waiting for a usage loader — the abyss status bar collects usage for kept windows.")));
    }
    const body = v_flex().flex_1().min_h(0).overflow_y_scrollbar().py(8);
    const anyAvail = (d.agents ?? []).some(a => a.available);
    if (!anyAvail) {
      body.child(div().px(16).py(14).text_size(12).text_color(t.dim).child("No agent CLI records found on this machine yet."));
    } else {
      const tp = pick(d.totals, this.range);
      const dates = rangeDays(d, this.range);
      const inR = new Set(dates);
      const totalRows = (d.totals.daily ?? []).map(row => {
        const parts = (d.agents ?? []).filter(a => a.available).map(a => {
          const day = (a.daily ?? []).find(x => x.date === row.date);
          return { v: day ? (day.in ?? 0) + (day.out ?? 0) : 0, c: colorOf(t, a.key) };
        }).filter(pt => pt.v > 0);
        return { parts, tooltip: `${row.date} · ${fmt((row.in ?? 0) + (row.out ?? 0))} tokens`, date: row.date };
      });
      body
        .when(live.length > 0, el => el.child(h_flex().flex_none().px(12).pb(8).gap(10).items_center().text_size(11).text_color(t.muted)
          .child(h_flex().gap(4).items_center().child(dot(t.working)).child(`${nWork} working`))
          .child(h_flex().gap(4).items_center().child(dot(t.ansi1 ?? t.blocked)).child(`${nBlock} need you`))
          .child(h_flex().gap(4).items_center().child(dot(t.dim)).child(`${nIdle} idle`))))
        .child(v_flex().flex_none().mx(10).mb(8).px(12).py(10).rounded(10).bg(t.raised).border_1().border_color(t.border).gap(6)
          .child(v_flex().gap(1)
            .child(div().text_size(26).font_semibold().text_color(t.foreground).child(fmt(tokens(tp))))
            .child(div().text_size(10.5).text_color(t.dim).child("tokens in + out")))
          .child(h_flex().gap(8)
            .child(statCol(t, "Input", fmt(tp.in)))
            .child(statCol(t, "Output", fmt(tp.out)))
            .child(statCol(t, "Cached", fmt(cached(tp))))
            .child(statCol(t, "Sessions", String(tp.sessions ?? 0))))
          .when(Boolean(money(tp.cost)) || (tp.credits ?? 0) > 0, el => el.child(
            h_flex().gap(10).text_size(11).text_color(t.muted)
              .when(Boolean(money(tp.cost)), e => e.child(div().child(money(tp.cost))))
              .when((tp.credits ?? 0) > 0, e => e.child(div().child(`${fmt(tp.credits)} credits`))))))
        .child(v_flex().flex_none().mx(10).mb(8).px(12).py(10).rounded(10).bg(t.raised).border_1().border_color(t.border).gap(6)
          .child(div().text_size(11).font_medium().text_color(t.dim).child("Last 30 days"))
          .child(bars(t, totalRows, (i, r) => inR.has(r.date), 72, true))
          .child(h_flex().text_size(9.5).text_color(t.dim)
            .child(div().child(totalRows[0]?.date ?? ""))
            .child(div().flex_1())
            .child(div().child("today"))));
      const { used, idle } = ranked(d, this.range);
      for (const e of used) {
        const series = agentDaily(e.agent, d, this.range);
        body.child(this.agentCard(t, e, series, dates));
      }
      if (idle.length) {
        body.child(div().flex_none().px(14).pb(4).text_size(10.5).text_color(t.dim)
          .child(`No usage in this range: ${idle.map(a => a.name ?? a.key).join(", ")}`));
      }
      body.child(v_flex().flex_none().px(14).pt(8).pb(10).gap(2).text_size(10.5).text_color(t.dim)
        .child(div().child("Read from each CLI's own records on this machine. Nothing is sent anywhere."))
        .child(div().child("Tokens are input + output. Cached tokens are counted separately.")));
    }
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13).child(head).child(body);
  }
}
