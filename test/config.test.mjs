/**
 * Config defaults, unit-tested — because the failure mode is silent.
 *
 * Every field in ~/.triago/config.json is optional, so an absent or partial
 * file has to parse into a fully-populated object. The nested objects are the
 * trap: zod's `.default(v)` hands `v` straight back as output without running
 * it through the schema, so `.default({})` on `editor` would leave
 * `cfg.editor.enabled` undefined rather than false. Undefined is falsy, so the
 * editor deep-link would quietly stay off and look like a config bug; the tmux
 * equivalent would be worse, since a truthy value there types into a user's
 * terminal. `.prefault({})` parses the value, which is what fills these in.
 *
 * These assertions are about the shape being *materialised*, not about the
 * particular defaults — the point is that nothing nested comes back undefined.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const { Config } = await import(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "config.js")
);

test("an empty config parses into every field, nested ones included", () => {
  const cfg = Config.parse({});

  assert.equal(typeof cfg.open_browser, "string");
  assert.equal(typeof cfg.open_browser_cooldown_sec, "number");
  assert.equal(typeof cfg.notify, "boolean");
  assert.equal(typeof cfg.session_regex, "string");
  assert.deepEqual(cfg.repo_roots, {});

  // The two that `.default({})` would have left hollow.
  assert.equal(typeof cfg.editor.enabled, "boolean");
  assert.equal(typeof cfg.editor.command, "string");
  assert.equal(typeof cfg.tmux.inject, "boolean");
});

test("the side effects that touch the machine are off unless asked for", () => {
  const cfg = Config.parse({});
  assert.equal(cfg.editor.enabled, false, "editor spawns a process");
  assert.equal(cfg.tmux.inject, false, "tmux injection types into a terminal");
  assert.equal(cfg.notify, false, "notifications shell out");
});

test("a partial nested object keeps the defaults it did not mention", () => {
  const cfg = Config.parse({ editor: { enabled: true } });
  assert.equal(cfg.editor.enabled, true);
  assert.equal(typeof cfg.editor.command, "string");
  assert.ok(cfg.editor.command.length > 0, "command must survive a partial editor block");
});

test("repo_roots keeps its string values", () => {
  const cfg = Config.parse({ repo_roots: { demo: "/tmp/demo" } });
  assert.equal(cfg.repo_roots.demo, "/tmp/demo");
});
