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

/**
 * detached(), but it waits long enough to find out whether the process started.
 * Node emits 'spawn' once the child is running and 'error' if it never was —
 * exactly one of the two, and both arrive on the next tick or so. Nothing waits
 * for the child to EXIT, so the caller is not blocked on a browser or an editor
 * staying open.
 */
function detachedStarted(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    } catch {
      resolve(false);
      return;
    }
    child.on("spawn", () => {
      child.unref();
      resolve(true);
    });
    child.on("error", () => resolve(false));
  });
}

/**
 * The launcher that hands a URL to the desktop's default browser.
 *
 * Windows used to be `start`, which is a **cmd.exe builtin rather than an
 * executable**: spawn() ENOENTs on it every time, and because the spawn was
 * detached with its errors swallowed, nothing was printed. `explorer` is a real
 * executable and hands the URL to the registered handler. It is chosen over the
 * more commonly cited `cmd /c start "" <url>` deliberately — cmd.exe re-parses
 * its argument string, which would put a command interpreter back in the path of
 * a URL and break this module's one invariant (argv arrays, never a shell).
 *
 * Exported so the platform mapping can be asserted from any host, rather than
 * only on the platform that happens to be running the tests.
 */
export function browserCommand(platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") return "open";
  if (platform === "win32") return "explorer";
  return "xdg-open";
}

/**
 * Hand the URL to the default browser. Resolves to whether the LAUNCHER started
 * — not to whether a tab appeared, which no platform reports back and which this
 * function never had any way to know. It previously returned a bare `true`, so a
 * launcher that never ran still came back as success, and that value travels: it
 * becomes `opened_browser` in the response to whoever posted the card, and feeds
 * the "never opened in a browser" count in `triago status`. Reporting a tab that
 * does not exist is worse than reporting none, because the notification that
 * would have been someone's only signal is the thing it suppresses.
 *
 * TRIAGO_NO_BROWSER=1 suppresses the launch, and returns false because none
 * happened.
 */
export async function openBrowser(url: string): Promise<boolean> {
  if (process.env.TRIAGO_NO_BROWSER) {
    console.log(`[triago] TRIAGO_NO_BROWSER set — not opening ${url.split("#")[0]}`);
    return false;
  }
  return detachedStarted(browserCommand(), [url]);
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
      if (chunk.toString().trim() === "open") void openBrowser(url);
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
    detached("osascript", [
      "-e",
      `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`,
    ]);
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

export async function openInEditor(
  repo: string | undefined,
  file: string,
  line?: number,
): Promise<OpenResult> {
  const cfg = loadConfig();
  if (!cfg.editor.enabled)
    return { opened: false, reason: "editor deep-links are disabled in ~/.triago/config.json" };
  const abs = resolveFile(repo, file);
  if (!abs)
    return {
      opened: false,
      reason: `could not resolve ${file} (set repo_roots in ~/.triago/config.json)`,
    };

  const parts = cfg.editor.command.split(/\s+/).filter(Boolean);
  if (!parts.length) return { opened: false, reason: "editor.command is empty" };
  const argv = parts.map((p) =>
    p
      .replaceAll("{abs}", abs)
      .replaceAll("{file}", file)
      .replaceAll("{line}", String(line ?? 1)),
  );
  // Same false success openBrowser had: the path resolved, so the old code
  // reported `opened: true` without waiting to learn whether the editor binary
  // exists. A typo in editor.command is the common case, and it looked identical
  // to a working deep link.
  if (!(await detachedStarted(argv[0]!, argv.slice(1))))
    return {
      opened: false,
      reason: `could not start ${argv[0]} (check editor.command)`,
      resolved: abs,
    };
  return { opened: true, resolved: abs };
}
