import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_PORT = Number(process.env.TRIAGO_PORT ?? 5599);

/** All state lives in one directory so there is exactly one thing to back up or delete. */
export const TRIAGO_HOME = process.env.TRIAGO_HOME
  ? path.resolve(process.env.TRIAGO_HOME)
  : path.join(os.homedir(), ".triago");

export const CARDS_DIR = path.join(TRIAGO_HOME, "cards");
export const TOKEN_FILE = path.join(TRIAGO_HOME, "token");
export const SERVER_FILE = path.join(TRIAGO_HOME, "server.json");
export const LOG_FILE = path.join(TRIAGO_HOME, "server.log");
export const CONFIG_FILE = path.join(TRIAGO_HOME, "config.json");
export const STATE_FILE = path.join(TRIAGO_HOME, "state.json");

/** dist/ — where cli.js, server.js and web/ live once built. */
export const DIST_DIR = path.dirname(fileURLToPath(import.meta.url));
export const WEB_DIR = path.join(DIST_DIR, "web");

export function ensureHome(): void {
  fs.mkdirSync(CARDS_DIR, { recursive: true, mode: 0o700 });
}

/**
 * Token lives on disk, not in server memory, so it survives restarts and is
 * readable by any CLI/MCP process the user starts — and by nothing else (0600).
 */
export function readOrCreateToken(): string {
  ensureHome();
  try {
    const existing = fs.readFileSync(TOKEN_FILE, "utf8").trim();
    if (existing.length >= 16) return existing;
  } catch {
    /* mint below */
  }
  const token = randomBytes(24).toString("base64url");
  fs.writeFileSync(TOKEN_FILE, token + "\n", { mode: 0o600 });
  return token;
}

export function readToken(): string | null {
  try {
    const t = fs.readFileSync(TOKEN_FILE, "utf8").trim();
    return t.length >= 16 ? t : null;
  } catch {
    return null;
  }
}

export function cardDir(id: string): string {
  return path.join(CARDS_DIR, id);
}

export function version(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(DIST_DIR, "..", "package.json"), "utf8"));
    return String(pkg.version ?? "0.0.0");
  } catch {
    return "0.0.0";
  }
}

/** Small bits of cross-restart memory (currently: when a tab was last opened). */
export type TriagoState = { last_browser_open_at?: number };

export function readState(): TriagoState {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as TriagoState;
  } catch {
    return {};
  }
}

export function writeState(next: TriagoState): void {
  try {
    ensureHome();
    fs.writeFileSync(STATE_FILE, JSON.stringify({ ...readState(), ...next }, null, 2), {
      mode: 0o600,
    });
  } catch {
    /* losing this only costs an extra tab */
  }
}
