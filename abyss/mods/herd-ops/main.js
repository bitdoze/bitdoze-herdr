// herd-ops: sites + machines at a glance. Sites come from sites.json here
// (created from sites.default.json on first edit; "Add current space"
// appends to it). Spaces and commands resolve per click — a missing folder
// disables its actions instead of failing later. Uptime/health watching is
// left to real monitoring tools; this is a launcher. Everything it opens is
// a normal space/terminal, so it all shows up on the phone app too. Open it
// as a tab: tab.new {mod:"herd-ops"}, or dock it as a pane.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, machines, run, theme, shared, setShared, props, exec, readTextFile, writeTextFile, home, appHome, window, nextCommand, closeOverlay } from "herdr";

const SITES_FILE = "mods/herd-ops/sites.json";
const DEFAULT_FILE = "mods/herd-ops/sites.default.json";
const DATA = "herd-ops.config"; // {sites, folders, err, at}
let loading = false;

// Loaded once into shared() so every mount renders synchronously. Re-reads
// at most once a minute. sites.json is the user's file; sites.default.json
// is the shipped fallback.
function ensureData(cx) {
  const at = shared(DATA)?.at ?? 0;
  if (loading || Date.now() - at < 60000) return;
  loading = true;
  cx.spawn(async () => {
    try {
      const d = { sites: [], folders: {}, err: null, at: Date.now() };
      try {
        const text = (await readTextFile(`${appHome()}/${SITES_FILE}`))
          ?? (await readTextFile(`${appHome()}/${DEFAULT_FILE}`)) ?? "{}";
        d.sites = JSON.parse(text).sites ?? [];
      }
      catch (e) { d.err = `${e}`; }
      for (const s of d.sites) {
        const dir = resolve(s);
        if (!dir) continue;
        try {
          d.folders[s.name] = s.machine
            ? (await exec("hc", ["exec", "--on", s.machine, "test", "-d", dir])).code === 0
            : (await exec("test", ["-d", dir])).code === 0;
        } catch { d.folders[s.name] = false; }
      }
      setShared(DATA, d);
    } finally { loading = false; }
  });
}

// Remote sites keep their folder verbatim (paths on that machine); local
// sites expand ~ and relative folders against the local home.
const resolve = (site) => {
  const folder = site?.folder ?? site;
  if (!folder) return null;
  if (site?.machine) return folder;
  if (folder.startsWith("~")) return home() + folder.slice(1);
  return folder.startsWith("/") || /^[A-Za-z]:/.test(folder) ? folder : `${home()}/${folder}`;
};

export default class HerdOps extends View {
  init(_props, cx) {
    ensureData(cx);
    // <mod>.<command> via run() / herdr-app do. Commands reach every mount;
    // only the kept-window mount (the one with props().overlay) closes.
    cx.spawn(async () => {
      for (;;) {
        const c = await nextCommand();
        // A sync throw would reject this spawn and kill the loop — swallow it.
        try { if (c === "close" && props().overlay) closeOverlay(props().overlay); } catch {}
        cx.notify();
      }
    });
  }

  siteSpace(site) {
    const dir = resolve(site);
    const same = (s) => !site.machine || (s.machine ?? null) === site.machine;
    return spaces().find(s => same(s) && (s.folder === dir || (dir && s.folder === dir + "/")))
      ?? spaces().find(s => same(s) && s.name === site.name);
  }

  openSite(site) {
    const existing = this.siteSpace(site);
    if (existing) run("space.select", { id: existing.id });
    else run("space.new", { name: site.name, folder: resolve(site), ...(site.machine ? { machine: site.machine } : {}) });
  }

  runCmd(site, cmd) {
    const dir = resolve(site);
    const existing = this.siteSpace(site);
    if (!existing) {
      run("space.new", { name: site.name, folder: dir, argv: cmd.argv, ...(site.machine ? { machine: site.machine } : {}) });
      return;
    }
    run("space.select", { id: existing.id });
    run("terminal.open", { argv: cmd.argv, folder: dir, name: `${site.name}·${cmd.label}` });
  }

  addCurrentSpace(cx) {
    const space = spaces().find(s => s.active);
    if (!space) return;
    cx.spawn(async () => {
      const path = `${appHome()}/${SITES_FILE}`;
      try {
        const prev = await readTextFile(path);
        const sites = prev === null ? [] : (JSON.parse(prev).sites ?? []);
        if (sites.some(s => s.name === space.name && (s.machine ?? null) === (space.machine ?? null))) return;
        sites.push({ name: space.name, folder: space.folder, ...(space.machine ? { machine: space.machine } : {}), url: "", tags: [], commands: [] });
        await writeTextFile(path, `${JSON.stringify({ sites }, null, 2)}\n`, prev);
      } catch (e) { console.log(`herd-ops add: ${e}`); }
      setShared(DATA, { at: 0 });
      ensureData(cx);
    });
  }

  openUrl(site, cx) {
    cx.spawn(async () => {
      try { await exec(window()?.platform === "macos" ? "open" : "xdg-open", [site.url]); } catch {}
    });
  }

  machineChip(t, m) {
    const color = m.layout === "ready" ? t.done : m.layout === "loading" ? t.blocked : t.dim;
    const name = m.name ?? "this computer";
    return h_flex().id(`m-${m.name ?? "local"}`).h(28).px(10).gap(7).mr(6).items_center().rounded(8).flex_none()
      .bg(t.raised).border_1().border_color(t.border).text_size(11.5).text_color(m.layout === "unavailable" ? t.dim : t.muted)
      .cursor_pointer().hover(s => s.border_color(t.input).text_color(t.foreground))
      .on_click(() => run("space.new", m.name ? { machine: m.name } : {}))
      .child(svg(`mods/workspace-chrome/${m.name ? "server" : "monitor"}.svg`).size(12).text_color(color))
      .child(name)
      .child(div().text_size(10).text_color(color).child(m.layout === "ready" ? "" : m.layout));
  }

  siteCard(t, site, d) {
    const ok = d.folders[site.name];
    const dir = resolve(site);
    const sp = this.siteSpace(site);
    const chip = (id, label, enabled, action) => h_flex().id(id).h(22).px(8).mr(5).items_center().rounded(6).flex_none()
      .bg(enabled ? t.surface : t.raised).border_1().border_color(enabled ? t.input : t.border)
      .text_size(10.5).text_color(enabled ? t.muted : t.dim).cursor_pointer()
      .when(enabled, el => el.hover(s => s.border_color(t.accent).text_color(t.foreground)))
      .on_click((_e, cx) => { if (enabled) action(cx); }).child(label);
    return v_flex().id(`site-${site.name}`).flex_none().mx(10).mb(6).px(11).py(9).rounded(10).bg(t.raised).border_1().border_color(t.border).gap(6)
      .child(h_flex().items_center().gap(8)
        .child(div().flex_1().min_w(0).truncate().font_medium().text_size(12.5).text_color(t.foreground).child(site.name))
        .when(site.machine, el => el.child(
          h_flex().h(17).px(5).mr(4).gap(4).items_center().rounded(5).flex_none().bg(t.surface).text_size(9.5).text_color(t.dim)
            .child(svg("mods/workspace-chrome/server.svg").size(10)).child(site.machine)))
        .child(div().text_size(10.5).text_color(t.dim).truncate().child(dir ?? "")))
      .child(h_flex().items_center().gap(4)
        .children((site.tags ?? []).map((tag, i) => div().h(17).px(6).mr(1).rounded(5).bg(t.surface).text_size(9.5).text_color(t.dim).flex().items_center().child(tag)))
        .child(div().flex_1())
        .child(div().text_size(10).text_color(t.dim).truncate().child(ok === false ? "no folder" : (sp ? "space open" : ""))))
      .child(h_flex().items_center().pt(2)
        .child(chip(`sp-${site.name}`, "⌘ space", ok !== false && Boolean(dir), () => this.openSite(site)))
        .children((site.commands ?? []).map((c, i) => chip(`c-${site.name}-${i}`, `▸ ${c.label}`, ok !== false && Boolean(dir), () => this.runCmd(site, c, null))))
        .child(div().flex_1())
        .child(chip(`u-${site.name}`, "open ↗", Boolean(site.url), (cx) => this.openUrl(site, cx))));
  }

  render(cx) {
    // A throw here bricks the mount (frozen frame, dead clicks) — show an
    // error strip instead so a transient bad state can't take it down.
    try {
      return this.renderBody(cx);
    } catch (e) {
      const t = theme();
      return div().size_full().p(10).text_size(11).text_color(t.muted)
        .child(`herd-ops render error: ${e}`);
    }
  }

  renderBody(cx) {
    const t = theme();
    const d = shared(DATA) ?? { sites: [], folders: {} };
    ensureData(cx);
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(h_flex().px(14).h(44).flex_none().items_center().gap(8).border_b(1).border_color(t.border)
        .child(div().flex_1().text_size(12).font_semibold().text_color(t.foreground).child("Ops"))
        .child(div().id("ops-add").h(24).px(8).mr(6).rounded(6).text_size(11).text_color(t.dim).flex().items_center().cursor_pointer()
          .hover(s => s.bg(t.hover).text_color(t.foreground)).tooltip("Add the active space to sites.json")
          .on_click((_e, cx) => this.addCurrentSpace(cx))
          .child("+ Add current space"))
        .child(div().id("ops-edit").h(24).px(8).mr(6).rounded(6).text_size(11).text_color(t.dim).flex().items_center().cursor_pointer()
          .hover(s => s.bg(t.hover).text_color(t.foreground)).tooltip(`Edit ${SITES_FILE}`)
          .on_click((_e, cx) => cx.spawn(async () => {
            const path = `${appHome()}/${SITES_FILE}`;
            try {
              if ((await readTextFile(path)) === null) {
                const def = (await readTextFile(`${appHome()}/${DEFAULT_FILE}`)) ?? '{"sites": []}\n';
                await writeTextFile(path, def, null);
              }
              await exec(window()?.platform === "macos" ? "open" : "xdg-open", window()?.platform === "macos" ? ["-t", path] : [path]);
            }
            catch (e) { console.log(`herd-ops open: ${e}`); }
          }))
          .child("Edit sites"))
        .child(div().id("ops-refresh").size(22).rounded(6).flex().items_center().justify_center().text_color(t.dim).cursor_pointer()
          .hover(s => s.bg(t.hover).text_color(t.foreground)).tooltip("Reload sites.json")
          .on_click((_e, cx) => { setShared(DATA, { at: 0 }); ensureData(cx); })
          .child(svg("mods/workspace-chrome/spinner.svg").size(13).when(loading, el => el.spin(900))))
        .when((props() ?? {}).overlay, el => el.child(
          div().id("ops-close").size(22).rounded(6).flex_none().flex().items_center().justify_center().cursor_pointer()
            .hover(s => s.bg(t.hover)).tooltip("Close")
            .on_click(() => closeOverlay((props() ?? {}).overlay))
            .child(svg("mods/pane/close.svg").size(12).text_color(t.muted)))))
      .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar()
        .child(div().flex_none().px(14).pt(12).pb(7).text_size(10.5).font_medium().text_color(t.dim).child("MACHINES"))
        .child(h_flex().h(36).px(14).items_center().overflow_x_scrollbar().flex_none()
          .children(machines().map(m => this.machineChip(t, m)))
          .child(h_flex().id("m-add").h(28).px(9).items_center().rounded(8).flex_none().text_size(11).text_color(t.dim).cursor_pointer()
            .hover(s => s.bg(t.hover).text_color(t.foreground))
            .on_click(() => run("mod.open", { name: "machine-add" }))
            .child("+ add")))
        .child(div().flex_none().px(14).pt(10).pb(7).text_size(10.5).font_medium().text_color(t.dim).child("SITES"))
        .children(d.sites.map(s => this.siteCard(t, s, d)))
        .when(d.sites.length === 0, el => el.child(
          v_flex().flex_none().px(16).py(14).gap(10).items_start()
            .child(div().text_size(12).text_color(t.dim)
              .child(d.err ? `Could not read sites.json: ${d.err}` : "No sites yet. Add the space you are in, or edit sites.json."))
            .when(!d.err, el => el.child(
              h_flex().id("ops-add-empty").h(26).px(10).items_center().rounded(7).bg(t.raised).border_1().border_color(t.input)
                .text_size(11.5).text_color(t.muted).cursor_pointer()
                .hover(s => s.border_color(t.accent).text_color(t.foreground))
                .on_click((_e, cx) => this.addCurrentSpace(cx))
                .child("+ Add current space"))))))
      .child(h_flex().px(14).h(26).flex_none().items_center().border_t(1).border_color(t.border)
        .child(div().text_size(10).text_color(t.dim).truncate().child(SITES_FILE)));
  }
}
