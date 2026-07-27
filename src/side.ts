import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.js";

/**
 * Every outward-facing side effect lives here, each one a single small function
 * so the security surface is auditable in one screen. Nothing is run through a
 * shell: argv arrays only, so no config value can ever be interpolated into a
 * command line.
 */

function detached(cmd: string, args: string[]): void {
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* best effort by design */
  }
}

/** Returns whether a tab was actually launched. TRIAGO_NO_BROWSER=1 suppresses it. */
export function openBrowser(url: string): boolean {
  if (process.env.TRIAGO_NO_BROWSER) {
    console.log(`[triago] TRIAGO_NO_BROWSER set — not opening ${url.split("#")[0]}`);
    return false;
  }
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  detached(cmd, [url]);
  return true;
}

/**
 * tmux inject: types one line into the pane the card was posted from, which
 * wakes an agent that ended its turn. Opt-in; silently skipped if the pane is
 * gone (the agent may have exited long ago).
 */
export function tmuxInject(pane: string | undefined, line: string): boolean {
  if (!pane || !loadConfig().tmux.inject) return false;
  const list = spawnSync("tmux", ["list-panes", "-a", "-F", "#{pane_id}"], { encoding: "utf8" });
  if (list.status !== 0 || !list.stdout.split("\n").includes(pane)) return false;
  const send = spawnSync("tmux", ["send-keys", "-t", pane, line, "Enter"], { encoding: "utf8" });
  return send.status === 0;
}

/**
 * A notification you can click to open the card.
 *
 * This is the only channel that reaches someone who is not looking at the
 * screen, and it is the channel that matters most in the case it exists for: no
 * tab was opened, so the notification is the *only* thing that arrives. Telling
 * someone a card is waiting and then making them go and find it is most of the
 * way to telling them nothing.
 *
 * Linux only, and only where the notification daemon implements actions.
 * `notify-send --wait` stays alive until the notification is dismissed and
 * prints the chosen action's key, so this holds one short-lived process per
 * notification rather than polling anything. macOS `display notification` has
 * no click target without a third-party binary, so there it stays plain — worth
 * degrading rather than taking a dependency for.
 */
let actionSupport: boolean | null = null;

/**
 * `--action` and `--wait` arrived in libnotify 0.8; 0.7.x rejects them as
 * unknown options and prints nothing at all. Since the spawn is detached with
 * its errors swallowed, using them blind on an older notify-send would silently
 * remove the notification entirely — losing the one channel that reaches
 * somebody when no tab was opened, in exchange for a button. So ask first.
 */
function supportsAction(): boolean {
  if (actionSupport !== null) return actionSupport;
  try {
    const help = spawnSync("notify-send", ["--help"], { encoding: "utf8", timeout: 2000 });
    actionSupport = `${help.stdout}${help.stderr}`.includes("--action");
  } catch {
    actionSupport = false;
  }
  return actionSupport;
}

function notifyWithOpen(title: string, body: string, url: string): boolean {
  if (process.platform !== "linux" || !supportsAction()) return false;
  try {
    const child = spawn(
      "notify-send",
      ["-a", "triago", "--wait", "--action=open=Open card", title, body],
      { detached: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    child.on("error", () => {});
    child.stdout?.on("data", (chunk: Buffer) => {
      if (chunk.toString().trim() === "open") openBrowser(url);
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export function notify(title: string, body: string, openUrl?: string): void {
  if (!loadConfig().notify) return;
  if (openUrl && notifyWithOpen(title, body, openUrl)) return;
  if (process.platform === "darwin") {
    detached("osascript", ["-e", `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`]);
  } else {
    detached("notify-send", ["-a", "triago", title, body]);
  }
}

export type OpenResult = { opened: boolean; reason?: string; resolved?: string };

/**
 * Resolve a finding's path against the configured repo roots. Absolute paths
 * are only honoured when they sit inside a configured root: a card can quote
 * text from anywhere, and a click should never be able to open ~/.ssh/id_rsa.
 */
export function resolveFile(repo: string | undefined, file: string): string | null {
  const roots = loadConfig().repo_roots;
  if (path.isAbsolute(file)) {
    const inRoot = Object.values(roots).some(
      (root) => file === path.resolve(root) || file.startsWith(path.resolve(root) + path.sep),
    );
    return inRoot && fs.existsSync(file) ? file : null;
  }
  const candidates = repo && roots[repo] ? [roots[repo]!] : Object.values(roots);
  for (const root of candidates) {
    const base = path.resolve(root);
    const abs = path.resolve(base, file);
    // `..` in a card's path must not walk out of the repo it claims to be in.
    if (abs.startsWith(base + path.sep) && fs.existsSync(abs)) return abs;
  }
  return null;
}

export function openInEditor(repo: string | undefined, file: string, line?: number): OpenResult {
  const cfg = loadConfig();
  if (!cfg.editor.enabled) return { opened: false, reason: "editor deep-links are disabled in ~/.triago/config.json" };
  const abs = resolveFile(repo, file);
  if (!abs) return { opened: false, reason: `could not resolve ${file} (set repo_roots in ~/.triago/config.json)` };

  const parts = cfg.editor.command.split(/\s+/).filter(Boolean);
  if (!parts.length) return { opened: false, reason: "editor.command is empty" };
  const argv = parts.map((p) =>
    p
      .replaceAll("{abs}", abs)
      .replaceAll("{file}", file)
      .replaceAll("{line}", String(line ?? 1)),
  );
  detached(argv[0]!, argv.slice(1));
  return { opened: true, resolved: abs };
}
