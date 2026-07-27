import { timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { loadConfig, reloadConfig } from "./config.js";
import {
  DEFAULT_PORT,
  TRIAGO_HOME,
  SERVER_FILE,
  WEB_DIR,
  ensureHome,
  readOrCreateToken,
  readState,
  version,
  writeState,
} from "./paths.js";
import {
  CardInput,
  DecisionsInput,
  DecisionsRecord,
  Health,
  PROTOCOL,
  StoredCard,
} from "./schema.js";
import {
  DecisionError,
  createCard,
  deleteCard,
  listCards,
  lookupCard,
  readDecisions,
  submitDecisions,
} from "./store.js";
import { notify, openBrowser, openInEditor, tmuxInject } from "./side.js";

const STARTED_AT = new Date().toISOString();

type Event = { type: "card.created" | "card.decided" | "card.deleted"; id: string };

/**
 * How a parked long-poll ended. Deletion is its own outcome rather than a
 * timeout: a caller that asked for nine minutes should be told the card is gone
 * immediately, not left to discover it by waiting out the clock.
 */
type WaitOutcome =
  | { kind: "decided"; record: DecisionsRecord }
  | { kind: "deleted" }
  | { kind: "timeout" };

/** Long-polls parked on a card, and SSE clients watching the whole home. */
const waiters = new Map<string, Set<(outcome: WaitOutcome) => void>>();
const streams = new Set<(e: Event) => void>();

/**
 * Is an agent actually blocked on this card right now?
 *
 * A card being *open* is not the same thing, and conflating the two tells the
 * human a lie in exactly the case that matters. A real triage outruns any tool
 * timeout, so by the time someone submits, the agent that posted the card has
 * usually stopped listening. "Open" stays true; "something is waiting" does not.
 */
function hasWaiter(id: string): boolean {
  return (waiters.get(id)?.size ?? 0) > 0;
}

/** Returns how many waiters received the record. Zero means nobody heard it. */
function wakeWaiters(id: string, record: DecisionsRecord): number {
  let delivered = 0;
  for (const resolve of waiters.get(id) ?? []) {
    resolve({ kind: "decided", record });
    delivered++;
  }
  waiters.delete(id);
  return delivered;
}

/** Called when a card is deleted out from under anything waiting on it. */
function killWaiters(id: string): void {
  for (const resolve of waiters.get(id) ?? []) resolve({ kind: "deleted" });
  waiters.delete(id);
}

function broadcast(event: Event): void {
  for (const push of streams) push(event);
}

function waitForDecisions(id: string, seconds: number): Promise<WaitOutcome> {
  return new Promise((resolve) => {
    const existing = readDecisions(id);
    if (existing) return resolve({ kind: "decided", record: existing });
    const set = waiters.get(id) ?? new Set();
    waiters.set(id, set);
    const timer = setTimeout(() => {
      set.delete(onOutcome);
      resolve({ kind: "timeout" });
    }, seconds * 1000);
    function onOutcome(outcome: WaitOutcome): void {
      clearTimeout(timer);
      resolve(outcome);
    }
    set.add(onOutcome);
  });
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/**
 * Whether a new card should pop a browser tab.
 *
 * The naive rule — "open when no tab is listening" — pathologically spams tabs:
 * a tab that was opened but never activated may not connect, so "nobody is
 * listening" stays true and every subsequent card opens another one. Twelve
 * cards from a test run became twelve tabs. Hence the cooldown, which is
 * persisted so a server restart does not reset it either.
 */
export function shouldOpenBrowser(input: {
  mode: "first-card" | "always" | "never";
  listeners: number;
  cooldownSec: number;
  lastOpenedAt: number | undefined;
  now: number;
}): { open: boolean; reason: string } {
  if (input.mode === "never") return { open: false, reason: "open_browser is never" };
  if (input.mode === "always") return { open: true, reason: "open_browser is always" };
  if (input.listeners > 0) return { open: false, reason: "a tab is already listening" };
  const since = input.lastOpenedAt === undefined ? Infinity : (input.now - input.lastOpenedAt) / 1000;
  if (since < input.cooldownSec) {
    return { open: false, reason: `a tab was opened ${Math.round(since)}s ago` };
  }
  return { open: true, reason: "nothing is listening" };
}

export function buildApp(token: string, port: number): Hono {
  const app = new Hono();
  const allowedHosts = new Set([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `[::1]:${port}`,
    "127.0.0.1",
    "localhost",
  ]);

  /** DNS-rebinding defence: a hostile page resolves its own name to 127.0.0.1. */
  app.use("*", async (c, next) => {
    const host = c.req.header("host");
    if (host && !allowedHosts.has(host.toLowerCase())) {
      return c.json({ error: `host not allowed: ${host}` }, 403);
    }
    await next();
    c.res.headers.set("X-Content-Type-Options", "nosniff");
    c.res.headers.set("Referrer-Policy", "no-referrer");
  });

  const expected = Buffer.from(token);
  const tokenMatches = (candidate: string | undefined): boolean => {
    if (!candidate) return false;
    const given = Buffer.from(candidate);
    return given.length === expected.length && timingSafeEqual(given, expected);
  };

  /** Cards carry source code and review data — every data route needs the token. */
  app.use("/api/*", async (c, next) => {
    const auth = c.req.header("authorization") ?? "";
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : c.req.header("x-triago-token");
    if (!tokenMatches(bearer)) return c.json({ error: "unauthorized" }, 401);
    await next();
  });

  app.get("/healthz", (c) => {
    const health: Health = {
      ok: true,
      name: "triago",
      version: version(),
      protocol: PROTOCOL,
      pid: process.pid,
      started_at: STARTED_AT,
      home: TRIAGO_HOME,
    };
    return c.json(health);
  });

  app.post("/api/cards", async (c) => {
    const parsed = CardInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "invalid card", issues: parsed.error.issues }, 422);
    }
    const card = createCard(parsed.data);
    broadcast({ type: "card.created", id: card.id });

    const cfg = loadConfig();
    const url = `http://127.0.0.1:${port}/c/${card.id}`;
    const decision = shouldOpenBrowser({
      mode: cfg.open_browser,
      listeners: streams.size,
      cooldownSec: cfg.open_browser_cooldown_sec,
      lastOpenedAt: readState().last_browser_open_at,
      now: Date.now(),
    });
    let shouldOpen = false;
    if (decision.open) {
      shouldOpen = openBrowser(`${url}#t=${token}`);
      if (shouldOpen) writeState({ last_browser_open_at: Date.now() });
    }
    // Say why, every time. The reason travels back to whoever posted the card,
    // which for an MCP call is the agent — so when no tab appears the human is
    // left with no tab and no explanation. The log is where they can find one.
    console.log(
      shouldOpen
        ? `[triago] opened ${url}`
        : `[triago] no tab for ${card.id} — ${decision.reason ?? "declined"} · open it with: triago open ${card.id}`,
    );
    const items = card.type === "findings" ? card.findings.length : 1;
    // When a tab did open, the notification is a courtesy. When one did not, it
    // is the only thing that reaches the human at all — so it has to carry the
    // id, which is what they need to go and look at it.
    notify(
      card.title,
      shouldOpen
        ? `triago · ${card.type} · ${items} item${items === 1 ? "" : "s"}`
        : `triago · ${items} item${items === 1 ? "" : "s"} · no tab opened — triago open ${card.id}`,
    );

    return c.json(
      { id: card.id, url, opened_browser: shouldOpen, browser: decision.reason },
      201,
    );
  });

  app.get("/api/cards", (c) => {
    const session = c.req.query("session");
    // `waiting` is live process state, not something on disk, so it is attached
    // here rather than in the store: after a restart nothing is waiting, which
    // is the truth.
    const cards = listCards(session).map((card) => ({ ...card, waiting: hasWaiter(card.id) }));
    return c.json({ cards });
  });

  app.get("/api/cards/:id", (c) => {
    const found = lookupCard(c.req.param("id"));
    if (!found.ok) return c.json({ error: found.error }, found.status);
    return c.json({
      card: found.card,
      decisions: readDecisions(found.card.id),
      waiting: hasWaiter(found.card.id),
    });
  });

  app.get("/api/cards/:id/decisions", async (c) => {
    const found = lookupCard(c.req.param("id"));
    if (!found.ok) return c.json({ error: found.error }, found.status);
    const card = found.card;
    const waitParam = c.req.query("wait");
    if (!waitParam) {
      const decisions = readDecisions(card.id);
      return decisions ? c.json(decisions) : c.json({ error: "not decided yet" }, 404);
    }
    const seconds = Math.min(Math.max(Number(waitParam) || 30, 1), 900);
    const outcome = await waitForDecisions(card.id, seconds);
    if (outcome.kind === "timeout") return c.json({ error: "timeout", card: card.id }, 408);
    if (outcome.kind === "deleted") {
      return c.json({ error: "card deleted while waiting", card: card.id }, 410);
    }
    return c.json(outcome.record);
  });

  app.delete("/api/cards/:id", (c) => {
    const found = lookupCard(c.req.param("id"));
    if (!found.ok) return c.json({ error: found.error }, found.status);
    const card = found.card;
    // An open card may have an agent parked on it. Deleting that silently is
    // how you end up with a command that never returns, so it takes a
    // deliberate force and the waiters get told.
    if (card.status !== "decided" && c.req.query("force") !== "1") {
      return c.json(
        { error: "card is still open — pass force to delete it anyway", card: card.id },
        409,
      );
    }
    killWaiters(card.id);
    const removed = deleteCard(card.id);
    broadcast({ type: "card.deleted", id: card.id });
    return c.json({ deleted: removed, card: card.id });
  });

  app.post("/api/cards/:id/decisions", async (c) => {
    const found = lookupCard(c.req.param("id"));
    if (!found.ok) return c.json({ error: found.error }, found.status);
    const card = found.card;
    const parsed = DecisionsInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "invalid decisions", issues: parsed.error.issues }, 422);
    }
    try {
      const record = submitDecisions(card, parsed.data);
      const delivered = wakeWaiters(card.id, record);
      broadcast({ type: "card.decided", id: card.id });
      const injected = tmuxInject(
        card.tmux_pane,
        `[triago] ${card.id} submitted — ${record.tally.fix} fix / ${record.tally.skip} skip / ${record.tally.discuss} discuss / ${record.tally.defer} defer`,
      );
      // `delivered` is what lets the page stop claiming the agent got this. It
      // usually has not: submitting takes longer than the call that posted the
      // card, so the honest next step is telling the agent to come back for it.
      return c.json({ decisions: record, tmux_injected: injected, delivered: delivered > 0 });
    } catch (err) {
      if (err instanceof DecisionError) return c.json({ error: err.message }, err.status as 400);
      throw err;
    }
  });

  app.post("/api/open", async (c) => {
    const body = z
      .object({ repo: z.string().optional(), file: z.string(), line: z.number().optional() })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid request" }, 422);
    reloadConfig();
    const result = openInEditor(body.data.repo, body.data.file, body.data.line);
    return c.json(result, result.opened ? 200 : 409);
  });

  app.get("/api/events", (c) =>
    streamSSE(c, async (stream) => {
      let alive = true;
      const queue: Event[] = [];
      let notifyQueue: (() => void) | null = null;
      const push = (e: Event): void => {
        queue.push(e);
        notifyQueue?.();
      };
      streams.add(push);
      stream.onAbort(() => {
        alive = false;
        streams.delete(push);
        notifyQueue?.();
      });
      await stream.writeSSE({ event: "hello", data: JSON.stringify({ version: version() }) });
      while (alive) {
        while (queue.length) {
          await stream.writeSSE({ event: "change", data: JSON.stringify(queue.shift()) });
        }
        await Promise.race([
          new Promise<void>((r) => {
            notifyQueue = r;
          }),
          new Promise<void>((r) => setTimeout(r, 25000)),
        ]);
        notifyQueue = null;
        if (alive && !queue.length) await stream.writeSSE({ event: "ping", data: "1" });
      }
    }),
  );

  app.post("/api/shutdown", (c) => {
    setTimeout(() => process.exit(0), 50);
    return c.json({ stopping: true });
  });

  /** Keep API mistakes as JSON 404s — the SPA fallback below would answer 200 + HTML. */
  app.all("/api/*", (c) => c.json({ error: `no such endpoint: ${c.req.path}` }, 404));

  /** Prebuilt frontend. Unknown non-API paths fall back to the SPA shell. */
  app.get("*", (c) => {
    const url = new URL(c.req.url);
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const target = path.resolve(WEB_DIR, rel);
    const inside = target === WEB_DIR || target.startsWith(WEB_DIR + path.sep);
    const file = inside && rel && fs.existsSync(target) && fs.statSync(target).isFile()
      ? target
      : path.join(WEB_DIR, "index.html");
    if (!fs.existsSync(file)) {
      return c.text("triago frontend is not built — run `npm run build` in the triago repo", 500);
    }
    const body = fs.readFileSync(file);
    const headers: Record<string, string> = {
      "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
      "content-security-policy": CSP,
    };
    if (file.includes(`${path.sep}assets${path.sep}`)) {
      headers["cache-control"] = "public, max-age=31536000, immutable";
    } else {
      headers["cache-control"] = "no-store";
    }
    return new Response(new Uint8Array(body), { headers });
  });

  return app;
}

export function startServer(port = DEFAULT_PORT): void {
  ensureHome();
  const token = readOrCreateToken();
  const app = buildApp(token, port);
  const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, (info) => {
    fs.writeFileSync(
      SERVER_FILE,
      JSON.stringify(
        { pid: process.pid, port: info.port, version: version(), protocol: PROTOCOL, started_at: STARTED_AT },
        null,
        2,
      ),
    );
    console.log(`[triago] listening on http://127.0.0.1:${info.port} (pid ${process.pid})`);
  });
  const stop = (): void => {
    try {
      fs.rmSync(SERVER_FILE, { force: true });
    } catch {
      /* ignore */
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
