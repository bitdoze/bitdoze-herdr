// abyss brand block and sidebar footer for the abyss layout.
import { View, div, image, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, run, props, window, shared, setShared, layout, agents, updates, readTextFile, appHome } from "herdr";

// Whether optional mods are installed (e.g. vitals), cached in
// shared("abyss.has") and re-checked at most once a minute.
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
const hasVitals = () => shared("abyss.has")?.vitals === true;

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", { id: "sidebar", px: narrow() ? (shared("sidebar.width") ?? 272) : window()?.platform === "macos" ? 76 : 44 });
}

export default class AbyssChrome extends View {
  button(id, label, action) {
    const t = theme();
    return div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim)
      .hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(action).child(label);
  }

  render(cx) {
    const t = theme();
    const collapsed = narrow();
    ensureHas(cx);
    if (props()?.footer) {
      const needs = agents().filter(a => a.status === "blocked").length;
      const row = (id, icon, label, dim, action) => h_flex().id(id).h(28).px(8).gap(9).items_center().rounded(8)
        .when(collapsed, el => el.relative().w(32).px(0).justify_center().tooltip(label))
        .text_color(dim ? t.dim : t.muted).hover(s => s.bg(t.hover).text_color(t.foreground)).cursor_pointer()
        .on_click(action).child(svg(icon.includes("/") ? icon : `mods/workspace-chrome/${icon}.svg`).size(14))
        .when(!collapsed, el => el.child(label));
      const ready = div().size(6).rounded_full().bg(t.accent);
      return v_flex().size_full().bg(t.chrome).border_t(1).border_color(t.border).px(8).pt(4).pb(8).text_size(13)
        .when(collapsed, el => el.px(0).items_center())
        .child(row("settings", "settings", "Settings", false, () => run("app.settings"))
          .when(Boolean(updates().app.ready), el => el.child(collapsed ? ready.absolute().top(5).right(6) : ready)))
        .child(row("machine", "plus", "Add machine", true, () => run("mod.open", { name: "machine-add" }))
          .when(needs > 0, el => el.child(
            collapsed
              ? div().absolute().top(4).right(4).size(7).rounded_full().bg(t.blocked)
              : div().ml("auto").px(6).h(17).rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).flex().items_center().child(`${needs} needs you`))))
        .when(hasVitals(), el => el.child(
          row("vitals", "mods/vitals/icons/pulse.svg", "Vitals", true, () => run("mod.open", { name: "vitals" }))));
    }
    return h_flex().size_full().bg(t.chrome).pl(collapsed ? 6 : 14).pr(10).gap(8).items_center().text_size(13.5)
      .when(window()?.platform === "macos" && !window()?.fullscreen && !collapsed, el => el.pl(76))
      .when(!collapsed, el => el.child(h_flex().flex_1().gap(9).items_center()
        .child(div().size(24).rounded(7).bg(t.accent + "1f").border_1().border_color(t.accent + "66").flex().items_center().justify_center()
          .child(image("frame/welcome/herdr.png").size(15).rounded(4)))
        .child(div().font_semibold().text_color(t.foreground).child("Herdr"))
        .child(div().mt(1).text_size(9.5).font_medium().text_color(t.accent).child("ABYSS"))))
      .when(!collapsed, el => el.child(this.button("search", svg("mods/workspace-chrome/search.svg").size(15), () => run("mod.open", { name: "picker" }))))
      .when(!(collapsed && window()?.platform === "macos"), el => el.child(this.button("sidebar-toggle", svg("mods/workspace-chrome/sidebar.svg").size(15), toggleSidebar)));
  }
}
