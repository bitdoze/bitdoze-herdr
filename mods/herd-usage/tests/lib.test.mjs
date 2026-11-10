import test from "node:test";
import assert from "node:assert/strict";
import { fmt, tokens, cached, pick, rangeDays, ranked, resetsIn, money, ago } from "../mods/herd-usage/lib.js";

test("fmt", () => {
  const cases = [[0, "0"], [999, "999"], [1000, "1k"], [1234, "1.2k"], [12345, "12k"],
    [123456, "123k"], [999999, "1M"], [1500000, "1.5M"], [12340000, "12M"], [2500000000, "2.5B"]];
  for (const [n, want] of cases) assert.equal(fmt(n), want, String(n));
});

test("tokens/cached", () => {
  const p = { in: 10, out: 5, cache_read: 3, cache_write: 2 };
  assert.equal(tokens(p), 15);
  assert.equal(cached(p), 5);
});

const P = (i, o) => ({ in: i, out: o, cache_read: 0, cache_write: 0, cost: 0, credits: 0, msgs: 0, sessions: 0 });
test("ranked", () => {
  const doc = { agents: [
    { key: "a", available: true, window: P(250, 50) },
    { key: "b", available: true, window: P(80, 20) },
    { key: "c", available: true, window: P(0, 0) },
    { key: "d", available: false, window: P(0, 0) },
    { key: "e", available: false, error: "boom", window: P(0, 0) }] };
  const r = ranked(doc, "window");
  assert.deepEqual(r.used.map(e => e.agent.key), ["a", "b", "e"]);
  assert.equal(r.used[0].share, 0.75);
  assert.equal(r.used[1].share, 0.25);
  assert.equal(r.used[2].share, 0);
  assert.deepEqual(r.idle.map(a => a.key), ["c"]);
});

const day = (d) => ({ date: d, in: 1, out: 1, cache_read: 0, cache_write: 0, cost: 0, credits: 0, msgs: 0 });
test("rangeDays", () => {
  const doc = { to: "2026-11-10", totals: { daily: Array.from({ length: 30 }, (_, i) => day(`2026-10-${String(i + 12).padStart(2, "0")}`)) } };
  doc.totals.daily[29].date = "2026-11-10";
  assert.equal(rangeDays(doc, "today").length, 1);
  assert.equal(rangeDays(doc, "d7").length, 7);
  assert.equal(rangeDays(doc, "window").length, 30);
  assert.equal(rangeDays(doc, "window").at(-1), "2026-11-10");
});

test("resetsIn", () => {
  const now = 1e12;
  assert.equal(resetsIn(now - 1000, now), "now");
  assert.equal(resetsIn(now + 45 * 60000, now), "45m");
  assert.equal(resetsIn(now + 5 * 3600000, now), "5h");
  assert.equal(resetsIn(now + 12 * 86400000, now), "12d");
});

test("money", () => {
  assert.equal(money(0), "");
  assert.equal(money(0.0234), "$0.02");
  assert.equal(money(0.004), "<$0.01");
  assert.equal(money(12.5), "$12.50");
});

test("ago", () => {
  const now = 1e12;
  assert.equal(ago(now - 30000, now), "just now");
  assert.equal(ago(now - 5 * 60000, now), "5m ago");
  assert.equal(ago(now - 3 * 3600000, now), "3h ago");
  assert.equal(ago(now - 2 * 86400000, now), "2d ago");
});
