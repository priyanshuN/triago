/**
 * The auto-open decision, unit-tested — because getting this wrong spams the
 * user's browser with tabs, and that is not something an integration test can
 * safely reproduce.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const { shouldOpenBrowser } = await import(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "server.js")
);

const base = { mode: "first-card", listeners: 0, cooldownSec: 300, lastOpenedAt: undefined, now: 10_000_000 };

test("opens for the first card when nothing is listening", () => {
  assert.equal(shouldOpenBrowser(base).open, true);
});

test("never opens a second tab while one is listening", () => {
  assert.equal(shouldOpenBrowser({ ...base, listeners: 1 }).open, false);
});

test("a tab opened but never activated does not cause a second one", () => {
  // the bug: an unactivated tab has no SSE connection, so listeners stays 0
  const result = shouldOpenBrowser({ ...base, lastOpenedAt: base.now - 30_000 });
  assert.equal(result.open, false);
  assert.match(result.reason, /opened 30s ago/);
});

test("opens again once the cooldown has passed", () => {
  assert.equal(shouldOpenBrowser({ ...base, lastOpenedAt: base.now - 400_000 }).open, true);
});

test("twelve cards in a row produce exactly one tab", () => {
  let lastOpenedAt;
  let opened = 0;
  for (let i = 0; i < 12; i++) {
    const now = base.now + i * 1000;
    if (shouldOpenBrowser({ ...base, now, lastOpenedAt }).open) {
      opened++;
      lastOpenedAt = now;
    }
  }
  assert.equal(opened, 1, "this is the regression that spammed the browser");
});

test("mode never and always are absolute", () => {
  assert.equal(shouldOpenBrowser({ ...base, mode: "never" }).open, false);
  assert.equal(shouldOpenBrowser({ ...base, mode: "always", listeners: 5 }).open, true);
});
