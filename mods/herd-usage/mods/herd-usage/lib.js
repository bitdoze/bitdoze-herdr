// herd-usage pure helpers — no app imports so node --test can run this.

export function fmt(n) {
  if (n < 1000) return String(Math.round(n));
  for (const [div, s] of [[1e9, "B"], [1e6, "M"], [1e3, "k"]]) {
    const v = n / div;
    const r = v >= 10 ? Math.round(v) : Math.round(v * 10) / 10;
    if (r >= 1000) continue;
    if (v >= 0.5) return `${r}`.replace(/\.0$/, "") + s;
  }
  return String(Math.round(n));
}

export const tokens = (p) => (p?.in ?? 0) + (p?.out ?? 0);
export const cached = (p) => (p?.cache_read ?? 0) + (p?.cache_write ?? 0);

export function pick(node, range) {
  return node?.[range] ?? node?.window ?? { in: 0, out: 0, cache_read: 0, cache_write: 0, cost: 0, credits: 0, msgs: 0, sessions: 0 };
}

export function rangeDays(doc, range) {
  const dates = (doc?.totals?.daily ?? []).map(d => d.date);
  if (range === "today") return dates.slice(-1);
  if (range === "d7") return dates.slice(-7);
  return dates;
}

export function ranked(doc, range) {
  const used = [], idle = [];
  for (const a of doc?.agents ?? []) {
    if (a.available === false && !a.error) continue;
    const p = pick(a, range);
    if (!a.available || tokens(p) > 0 || a.error) used.push({ agent: a, p, share: 0 });
    else idle.push(a);
  }
  const total = used.reduce((s, e) => s + tokens(e.p), 0);
  used.sort((x, y) => tokens(y.p) - tokens(x.p));
  for (const e of used) e.share = total ? tokens(e.p) / total : 0;
  return { used, idle };
}

export function resetsIn(ms, now) {
  const d = (ms ?? 0) - now;
  if (d <= 0) return "now";
  const m = Math.round(d / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export function money(x) {
  if (!x || x <= 0) return "";
  if (x < 0.005) return "<$0.01";
  return `$${x.toFixed(2)}`;
}

export function ago(ms, now) {
  const s = ((now ?? Date.now()) - (ms ?? 0)) / 1000;
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function windowLabel(minutes) {
  if (!minutes) return "";
  if (minutes % 1440 === 0) return `${minutes / 1440}-day`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour`;
  return `${minutes}-minute`;
}

// Per-agent daily series aligned to the doc's daily rows.
export function agentDaily(agent, doc, range) {
  const dates = (doc?.totals?.daily ?? []).map(d => d.date);
  const idx = new Map((agent?.daily ?? []).map(d => [d.date, d]));
  return dates.map(date => ({ date, p: idx.get(date) ?? { in: 0, out: 0, cache_read: 0, cache_write: 0 } }));
}
