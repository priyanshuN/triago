import fs from "node:fs";
import { z } from "zod";
import { CONFIG_FILE } from "./paths.js";

/**
 * Everything that touches the user's machine beyond writing to ~/.triago is
 * opt-in here: opening a browser is the only default-on side effect.
 */
export const Config = z.object({
  /** first-card = open a tab only when no triago tab is already listening. */
  open_browser: z.enum(["first-card", "always", "never"]).default("first-card"),
  /**
   * A tab that has been opened but never activated does not connect, so
   * "nobody is listening" stays true and every further card opens another tab.
   * This is the backstop: no second auto-open within this many seconds.
   */
  open_browser_cooldown_sec: z.number().int().min(0).default(300),
  /** Deep-link a finding's file:line into an editor. Off by default (spawns a process). */
  editor: z
    .object({
      enabled: z.boolean().default(false),
      /** Argv template; {file} {line} {abs} are substituted. Never run through a shell. */
      command: z.string().default("code -g {abs}:{line}"),
    })
    // prefault, not default: zod 4's `default` hands the value straight back as
    // output without parsing it, so `{}` would stay `{}` and every read of
    // cfg.editor.enabled would be undefined. `prefault` feeds it through the
    // schema, which is what fills in the field defaults below it.
    .prefault({}),
  /** Wake a waiting agent by typing into its tmux pane. Off by default. */
  tmux: z.object({ inject: z.boolean().default(false) }).prefault({}),
  /** Desktop notification on new cards (notify-send / osascript). Off by default. */
  notify: z.boolean().default(false),
  /** Session key inference from the current git branch. */
  session_regex: z.string().default("[A-Z][A-Z0-9]+-\\d+"),
  /** repo name -> absolute path, used to resolve finding.file for editor deep-links. */
  repo_roots: z.record(z.string(), z.string()).default({}),
});
export type Config = z.infer<typeof Config>;

let cached: Config | null = null;

export function loadConfig(): Config {
  if (cached) return cached;
  let raw: unknown = {};
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    /* defaults */
  }
  const parsed = Config.safeParse(raw);
  cached = parsed.success ? parsed.data : Config.parse({});
  return cached;
}

export function reloadConfig(): Config {
  cached = null;
  return loadConfig();
}
