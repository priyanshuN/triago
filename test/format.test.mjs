/**
 * The midnight hour, which is the only hour this can get wrong.
 *
 * `hour12: false` reads like "use a 24-hour clock" and mostly behaves like it —
 * but several locales resolve it to the h24 cycle, where midnight is hour 24
 * rather than 0. A card created at 00:07 then lists as `24:07`, in the CLI and
 * in the rail, for one hour a night. It shipped that way, because every test
 * and every manual check happened at some other time of day.
 *
 * These assert the property rather than an exact string: the locale is the
 * reader's, so the formatted output legitimately differs between machines, but
 * midnight is hour 00 everywhere and no hour is ever 24.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const { formatClock } = await import(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "format.js")
);

/** Local-time midnight, so the assertion does not depend on the runner's zone. */
const atLocal = (h, m) => {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.toISOString();
};

test("midnight is hour 00, never hour 24", () => {
  for (const minute of [0, 7, 30, 59]) {
    const out = formatClock(atLocal(0, minute));
    assert.ok(!out.startsWith("24"), `midnight rendered as ${out}`);
    assert.match(out, /^00:/, `expected 00:xx, got ${out}`);
  }
});

test("no hour ever renders as 24", () => {
  for (let h = 0; h < 24; h++) {
    const out = formatClock(atLocal(h, 15));
    assert.ok(!out.startsWith("24"), `hour ${h} rendered as ${out}`);
  }
});

test("every hour of the day formats as two-digit HH:MM", () => {
  for (let h = 0; h < 24; h++) {
    assert.match(formatClock(atLocal(h, 5)), /^\d{2}:\d{2}$/);
  }
});

test("the hour reflects local time, not the UTC in the stamp", () => {
  // The bug this replaced sliced the ISO string and showed UTC to everyone.
  const iso = atLocal(13, 45);
  assert.match(formatClock(iso), /^13:45$/);
});
