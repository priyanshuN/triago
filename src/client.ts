import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_PORT, DIST_DIR, LOG_FILE, ensureHome, readOrCreateToken } from "./paths.js";
import type { CardInput, CardSummary, DecisionsInput, DecisionsRecord, Health, StoredCard } from "./schema.js";
import { PROTOCOL } from "./schema.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function probe(port: number, timeoutMs = 700): Promise<Health | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Health;
    return body?.name === "triago" ? body : null;
  } catch {
    return null;
  }
}

function spawnDetachedServer(port: number): void {
  ensureHome();
  const log = fs.openSync(LOG_FILE, "a");
  const child = spawn(process.execPath, [path.join(DIST_DIR, "cli.js"), "serve", "--port", String(port)], {
    detached: true,
    stdio: ["ignore", log, log],
  });
  child.on("error", () => {});
  child.unref();
}

/**
 * The ensure-server dance: every entry point (CLI command, MCP shim startup)
 * calls this, so nobody ever starts triago manually and a reboot needs no init
 * system — the next invocation brings the daemon back.
 */
export async function ensureServer(port = DEFAULT_PORT): Promise<TriagoClient> {
  const token = readOrCreateToken();
  const health = await probe(port);
  if (health) {
    if (health.protocol === PROTOCOL) return new TriagoClient(port, token);
    // A newer/older triago is squatting the port (npx upgrade): ask it to stand down.
    await new TriagoClient(port, token).stop().catch(() => {});
    for (let i = 0; i < 20 && (await probe(port, 300)); i++) await sleep(150);
  }

  spawnDetachedServer(port);
  for (let i = 0; i < 60; i++) {
    await sleep(i < 10 ? 100 : 300);
    const up = await probe(port, 400);
    if (up) return new TriagoClient(port, token);
  }
  throw new Error(`triago server did not start on port ${port} — see ${LOG_FILE}`);
}

/** Carries the status so callers can tell "retry later" from "never going to work". */
export class TriagoHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class TriagoClient {
  constructor(
    readonly port: number,
    readonly token: string,
  ) {}

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  private async call<T>(method: string, route: string, body?: unknown, timeoutMs?: number): Promise<T> {
    const res = await fetch(this.baseUrl + route, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    });
    if (res.status === 408) return { __timeout: true } as T;
    const text = await res.text();
    const data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!res.ok) {
      const detail = typeof data.error === "string" ? data.error : res.statusText;
      throw new TriagoHttpError(`triago ${route} → ${res.status} ${detail}`, res.status);
    }
    return data as T;
  }

  postCard(
    input: CardInput,
  ): Promise<{ id: string; url: string; opened_browser: boolean; browser?: string }> {
    return this.call("POST", "/api/cards", input);
  }

  listCards(session?: string): Promise<{ cards: CardSummary[] }> {
    return this.call("GET", `/api/cards${session ? `?session=${encodeURIComponent(session)}` : ""}`);
  }

  getCard(id: string): Promise<{ card: StoredCard; decisions: DecisionsRecord | null }> {
    return this.call("GET", `/api/cards/${encodeURIComponent(id)}`);
  }

  submit(id: string, decisions: DecisionsInput): Promise<{ decisions: DecisionsRecord }> {
    return this.call("POST", `/api/cards/${encodeURIComponent(id)}/decisions`, decisions);
  }

  /** One long-poll. Returns null on timeout so callers own the retry budget. */
  async awaitOnce(id: string, seconds: number): Promise<DecisionsRecord | null> {
    const result = await this.call<DecisionsRecord & { __timeout?: boolean }>(
      "GET",
      `/api/cards/${encodeURIComponent(id)}/decisions?wait=${seconds}`,
      undefined,
      (seconds + 10) * 1000,
    );
    return result.__timeout ? null : result;
  }

  /** Deleting an open card needs force — something may still be parked on it. */
  remove(id: string, force = false): Promise<{ deleted: boolean; card: string }> {
    return this.call("DELETE", `/api/cards/${encodeURIComponent(id)}${force ? "?force=1" : ""}`);
  }

  stop(): Promise<unknown> {
    return this.call("POST", "/api/shutdown");
  }
}

/**
 * Blocking wait with a total deadline, re-issuing long-polls and re-ensuring the
 * server if it died mid-wait (cards live on disk, so nothing is lost).
 */
export async function waitForDecisions(
  id: string,
  totalSeconds: number,
  port = DEFAULT_PORT,
): Promise<DecisionsRecord | null> {
  const deadline = Date.now() + totalSeconds * 1000;
  let client = await ensureServer(port);
  while (Date.now() < deadline) {
    const remaining = Math.ceil((deadline - Date.now()) / 1000);
    const chunk = Math.min(50, Math.max(1, remaining));
    try {
      const record = await client.awaitOnce(id, chunk);
      if (record) return record;
    } catch (err) {
      // A bad card id or a stale token will never fix itself: fail fast instead
      // of burning the whole wait budget and reporting it as a human being slow.
      if (err instanceof TriagoHttpError && err.status < 500) throw err;
      await sleep(300);
      client = await ensureServer(port);
    }
  }
  return null;
}
