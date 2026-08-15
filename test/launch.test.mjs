/**
 * What the launchers report back, unit-tested — because the bug these cover was
 * not "it failed" but "it failed and said it worked", and that shape is
 * invisible to an integration test that only ever runs on a working machine.
 *
 * On Windows `start` is a cmd.exe builtin rather than an executable, so spawn
 * ENOENTed on every card, the detached spawn swallowed the error, and the return
 * value was a hardcoded `true` regardless. That value is not cosmetic: it
 * becomes `opened_browser` in the response to whoever posted the card, and feeds
 * the "never opened in a browser" count in `triago status`.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { dist } from "./dist.mjs";

// paths.js resolves TRIAGO_HOME into module-level constants at import time, so a
// test home has to exist BEFORE the first import — setting it afterwards points
// the config loader at the developer's real ~/.triago. node:test gives each file
// its own process, so doing it at the top leaks nowhere.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "triago-launch-home-"));
const REPO = fs.mkdtempSync(path.join(os.tmpdir(), "triago-launch-repo-"));
process.env.TRIAGO_HOME = HOME;
fs.writeFileSync(path.join(REPO, "a.ts"), "export const a = 1;\n");
fs.writeFileSync(
  path.join(HOME, "config.json"),
  JSON.stringify({
    editor: { enabled: true, command: "triago-no-such-editor-binary {abs}:{line}" },
    repo_roots: { r: REPO },
  }),
);
process.on("exit", () => {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.rmSync(REPO, { recursive: true, force: true });
});

const { browserCommand, openBrowser, openInEditor } = await dist("side.js");

// The mapping is a pure function precisely so every platform's answer can be
// asserted from whichever platform is running the suite — the Windows arm is the
// one that was wrong for the whole life of the package, and it was wrong on a
// host nobody here runs.
test("each platform maps to a launcher that is a real executable", () => {
  assert.equal(browserCommand("darwin"), "open");
  assert.equal(browserCommand("linux"), "xdg-open");
  assert.equal(browserCommand("win32"), "explorer");
});

test("windows never routes through a shell builtin", () => {
  // `start` is the trap: it reads like a command and is not one. `cmd` would
  // work but re-parses its argument string, which is the interpolation this
  // module exists to avoid.
  assert.notEqual(browserCommand("win32"), "start");
  assert.notEqual(browserCommand("win32"), "cmd");
});

test("TRIAGO_NO_BROWSER reports that no tab was opened", async () => {
  const before = process.env.TRIAGO_NO_BROWSER;
  process.env.TRIAGO_NO_BROWSER = "1";
  try {
    assert.equal(await openBrowser("http://127.0.0.1:1/c/x#t=secret"), false);
  } finally {
    if (before === undefined) delete process.env.TRIAGO_NO_BROWSER;
    else process.env.TRIAGO_NO_BROWSER = before;
  }
});

/**
 * The editor path carried the identical defect and is the one that can be driven
 * to its failure branch on any host: point editor.command at a binary that does
 * not exist and the old code still answered `opened: true`, because it only ever
 * checked that the FILE resolved.
 */
test("a misconfigured editor command reports failure, not success", async () => {
  const result = await openInEditor("r", "a.ts", 3);
  assert.equal(result.opened, false, "a launcher that never started is not an open");
  assert.match(result.reason, /triago-no-such-editor-binary/);
  // The path still resolved — the failure is the launch, and saying which of the
  // two it was is the difference between a fixable message and a shrug.
  assert.equal(result.resolved, path.join(REPO, "a.ts"));
});
