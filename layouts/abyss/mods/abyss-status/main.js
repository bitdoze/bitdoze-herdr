// abyss status bar: machine, space, branch, agent tally, palette hint.
// Also detects whether the vitals mod is installed (shared("abyss.has"),
// re-checked at most once a minute) so the chip appears only then.
// It is also herd-usage's loader: the usage document lives in shared() so
// every mount context renders it — kept windows are separate JS runtimes
// where a spawn can't be relied on. ensureUsage runs the collector when the
// doc is missing/stale or a mount bumped shared("herd-usage.refresh").
import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, theme, run, window, keys, shared, setShared, readTextFile, exec, appHome } from "herdr";

let checking = false;

function ensureHas(cx) {
  const h = shared("abyss.has");
  if (checking || (h?.at && Date.now() - h.at < 60000)) return;
  checking = true;
  cx.spawn(async () => {
    try {
      let vitals = false;
      try { vitals = (await readTextFile(`${appHome()}/mods/vitals/mod.json`)) !== null; } catch {}
      setShared("abyss.has", { vitals, at: Date.now() });
    } finally { checking = false; }
  });
}

// herd-usage priming. shared keys: "herd-usage.doc" (the whole document),
// "herd-usage.meta" ({at, since?, loading, error}), "herd-usage.refresh"
// (ms of the last ask), "herd-usage.summary" ({at, today, d7}).
const U_DOC = "herd-usage.doc", U_META = "herd-usage.meta", U_REFRESH = "herd-usage.refresh", U_SUM = "herd-usage.summary";
const U_STALE = 5 * 60000;       // reload when the doc is older than this
const U_BUSY_LEEWAY = 90 * 1000; // a meta.loading this old is treated as dead
const U_FAIL_BACKOFF = 60000;    // after a failure, retry at most this often
let uLoading = false, uFailAt = 0;

function ensureUsage(cx) {
  if (uLoading) return;
  const m = shared(U_META) ?? {};
  const d = shared(U_DOC);
  const at = m.at ?? 0;
  const busy = m.loading === true && Date.now() - (m.since ?? at) < U_BUSY_LEEWAY;
  const want = (shared(U_REFRESH) ?? 0) > at || !d || Date.now() - at > U_STALE;
  if (!want || busy) return;
  if (uFailAt && Date.now() - uFailAt < U_FAIL_BACKOFF) return;
  uLoading = true;
  cx.spawn(async () => {
    setShared(U_META, { ...m, at, since: Date.now(), loading: true, error: null });
    try {
      const script = `${appHome()}/mods/herd-usage/usage.py`;
      if ((await readTextFile(script)) === null) {
        // herd-usage isn't installed: say so once, then idle on the backoff.
        uFailAt = Date.now();
        setShared(U_META, { at: Date.now(), loading: false, error: "herd-usage is not installed" });
        return;
      }
      const r = await exec("python3", [script, "--days", "30"], { timeout: 30000 });
      if (r.code !== 0) throw new Error(r.stderr.split("\n").find(l => l.trim()) ?? "usage.py failed");
      const doc = JSON.parse(r.stdout);
      const now = Date.now();
      setShared(U_DOC, doc);
      setShared(U_SUM, { at: now,
        today: (doc.totals?.today?.in ?? 0) + (doc.totals?.today?.out ?? 0),
        d7: (doc.totals?.d7?.in ?? 0) + (doc.totals?.d7?.out ?? 0) });
      setShared(U_META, { at: now, loading: false, error: null });
      uFailAt = 0;
    } catch (e) {
      uFailAt = Date.now();
      setShared(U_META, { at: Date.now(), loading: false, error: `${e}` });
    } finally { uLoading = false; }
  });
}

const hasVitals = () => shared("abyss.has")?.vitals === true;
const fmtShort = (n) => n >= 1e6 ? `${Math.round(n / 1e5) / 10}M` : n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(Math.round(n ?? 0));

export default class AbyssStatus extends View {
  init(_props, cx) {
    // The render pass below catches refresh flags the moment they land
    // (setShared re-renders every mod); the timer keeps the doc fresh when
    // nothing else re-renders this bar.
    cx.timer.every(60000, (cx) => ensureUsage(cx));
  }

  hint(t) {
    const mac = window()?.platform === "macos";
    const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
    const b = keys().find((k) => k.section === "global" && k.action === "app.palette");
    const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
    const key = parts && parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
    return key ? `${key}  commands` : "commands";
  }

  render(cx) {
    const t = theme();
    const space = spaces().find(s => s.active);
    const list = agents();
    const count = (s) => list.filter(a => a.status === s).length;
    const tally = (s, label) => count(s) > 0
      ? h_flex().gap(5).items_center().child(div().size(6).rounded(3).bg(t[s])).child(div().text_color(t[s === "blocked" ? s : "muted"]).child(`${count(s)} ${label}`))
      : null;
    ensureHas(cx);
    ensureUsage(cx);
    return h_flex().size_full().px(14).gap(14).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.5).text_color(t.muted)
      .child(h_flex().gap(6).items_center().child(svg(`mods/workspace-chrome/${space?.machine ? "server" : "monitor"}.svg`).size(12).text_color(t.dim)).child(space?.machine ?? "This computer"))
      .when(Boolean(space), el => el.child(div().text_color(t.dim).child("·")).child(div().max_w(160).truncate().text_color(t.muted).child(space.name)))
      .when(Boolean(space?.branch), el => el.child(h_flex().gap(5).items_center().child(svg("mods/workspace-chrome/branch.svg").size(12).text_color(t.dim)).child(space.branch)))
      .child(div().flex_1())
      .children([tally("blocked", "needs you"), tally("working", "working"), tally("done", "done")].filter(Boolean))
      .when(list.length === 0, el => el.child(div().text_color(t.dim).child("no agents")))
      .child(div().w(1).h(12).mx(2).bg(t.border))
      .when(Boolean(shared("herd-usage.summary")), el => el.child(
        h_flex().id("sb-usage").h(22).px(8).gap(5).items_center().rounded(6).cursor_pointer()
          .hover(s => s.bg(t.hover))
          .tooltip("Agent token usage today · click for details")
          .on_click(() => { run("layout.select", { stack: "panel-body", child: "herd-usage" }); run("layout.show", { id: "panel" }); })
          .child(svg("mods/herd-usage/chart.svg").size(13).text_color(t.muted))
          .child(div().text_size(11).text_color(t.muted).child(`${fmtShort(shared("herd-usage.summary").today)} today`))))
      .when(hasVitals(), el => el.child(
        div().id("vitals").h(18).px(6).rounded(5).flex().items_center().gap(4).text_color(t.dim).cursor_pointer()
          .hover(s => s.bg(t.hover).text_color(t.foreground)).tooltip("Machine vitals (⌘⌥V)")
          .on_click(() => run("mod.open", { name: "vitals" }))
          .child(svg("mods/vitals/icons/pulse.svg").size(11))
          .child("Vitals")))
      .child(div().id("palette").text_color(t.dim).hover(s => s.text_color(t.foreground)).on_click(() => run("app.palette")).child(this.hint(t)));
  }
}
