/**
 * Integration tests: they drive a real server over HTTP on a scratch TRIAGO_HOME,
 * because everything worth breaking here lives in the seams (auth, long-poll
 * wake-up, disk rescan after restart, CLI exit codes).
 *
 *   npm run build && npm test
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "dist", "cli.js");
const PORT = 5691;
const BASE = `http://127.0.0.1:${PORT}`;
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "triago-test-"));
// TRIAGO_NO_BROWSER is not optional here: without it every card posted by these
// tests opens a real browser tab.
const env = { ...process.env, TRIAGO_HOME: HOME, TRIAGO_PORT: String(PORT), TRIAGO_NO_BROWSER: "1" };

let server;
let token;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startServer() {
  const child = spawn(process.execPath, [CLI, "serve", "--port", String(PORT)], {
    env,
    stdio: "ignore",
  });
  for (let i = 0; i < 80; i++) {
    await sleep(60);
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) return child;
    } catch {
      /* not up yet */
    }
  }
  throw new Error("server never became healthy");
}

const auth = () => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

const CARD = {
  type: "findings",
  title: "Test review",
  source: "/test",
  session: "TEST-1",
  findings: [
    { severity: "critical", summary: "one", file: "a/b.java", line: 1 },
    { severity: "low", summary: "two" },
  ],
};

before(async () => {
  assert.ok(fs.existsSync(CLI), "run `npm run build` before `npm test`");
  server = await startServer();
  token = fs.readFileSync(path.join(HOME, "token"), "utf8").trim();
  assert.ok(token.length >= 16);
});

after(async () => {
  server?.kill("SIGTERM");
  await sleep(150);
  fs.rmSync(HOME, { recursive: true, force: true });
});

test("posting a card never opens a browser under TRIAGO_NO_BROWSER", async () => {
  const posted = await (
    await fetch(`${BASE}/api/cards`, { method: "POST", headers: auth(), body: JSON.stringify(CARD) })
  ).json();
  assert.equal(posted.opened_browser, false, "a test run must not spawn browser tabs");
});

test("healthz is open but data routes need the token", async () => {
  const health = await (await fetch(`${BASE}/healthz`)).json();
  assert.equal(health.name, "triago");

  const anonymous = await fetch(`${BASE}/api/cards`);
  assert.equal(anonymous.status, 401);

  const wrong = await fetch(`${BASE}/api/cards`, { headers: { authorization: "Bearer nope" } });
  assert.equal(wrong.status, 401);
});

test("a foreign Host header is refused (DNS rebinding)", async () => {
  // fetch() forbids setting Host, so this one goes out over node:http.
  const get = (hostHeader) =>
    new Promise((resolve) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: PORT,
          path: "/api/cards",
          headers: { host: hostHeader, authorization: `Bearer ${token}` },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.end();
    });
  assert.equal(await get("evil.example.com"), 403);
  assert.equal(await get(`localhost:${PORT}`), 200);
});

test("invalid cards are rejected with field detail", async () => {
  const res = await fetch(`${BASE}/api/cards`, {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ type: "findings", title: "no findings", findings: [] }),
  });
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.equal(body.error, "invalid card");
});

test("post → long-poll timeout → submit → decisions match, and re-submit is refused", async () => {
  const posted = await (
    await fetch(`${BASE}/api/cards`, { method: "POST", headers: auth(), body: JSON.stringify(CARD) })
  ).json();
  assert.match(posted.id, /^[0-9a-f]{8}$/);

  const list = await (await fetch(`${BASE}/api/cards`, { headers: auth() })).json();
  const summary = list.cards.find((c) => c.id === posted.id);
  assert.deepEqual(
    { open: summary.open_items, total: summary.total_items, status: summary.status },
    { open: 2, total: 2, status: "open" },
  );

  const timedOut = await fetch(`${BASE}/api/cards/${posted.id}/decisions?wait=1`, {
    headers: auth(),
  });
  assert.equal(timedOut.status, 408);

  const partial = await fetch(`${BASE}/api/cards/${posted.id}/decisions`, {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ items: [{ id: "f1", decision: "fix" }] }),
  });
  assert.equal(partial.status, 400);
  assert.match((await partial.json()).error, /undecided findings: f2/);

  const good = await fetch(`${BASE}/api/cards/${posted.id}/decisions`, {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({
      items: [
        { id: "f1", decision: "fix", comment: "yes" },
        { id: "f2", decision: "skip" },
      ],
      global_comment: "looks fine otherwise",
    }),
  });
  assert.equal(good.status, 200);
  const { decisions } = await good.json();
  assert.deepEqual(decisions.tally, { fix: 1, skip: 1, discuss: 0, defer: 0 });
  assert.equal(decisions.items[0].summary, "one", "decisions echo the finding for context");
  assert.equal(decisions.items[0].file, "a/b.java");
  assert.equal(decisions.global_comment, "looks fine otherwise");

  const again = await fetch(`${BASE}/api/cards/${posted.id}/decisions`, {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ items: [{ id: "f1", decision: "skip" }, { id: "f2", decision: "skip" }] }),
  });
  assert.equal(again.status, 409);

  const onDisk = JSON.parse(
    fs.readFileSync(path.join(HOME, "cards", posted.id, "decisions.json"), "utf8"),
  );
  assert.deepEqual(onDisk.tally, decisions.tally);
});

test("a parked long-poll wakes up as soon as decisions land", async () => {
  const posted = await (
    await fetch(`${BASE}/api/cards`, { method: "POST", headers: auth(), body: JSON.stringify(CARD) })
  ).json();

  const started = Date.now();
  const parked = fetch(`${BASE}/api/cards/${posted.id}/decisions?wait=30`, { headers: auth() });
  await sleep(200);
  await fetch(`${BASE}/api/cards/${posted.id}/decisions`, {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({
      items: [{ id: "f1", decision: "discuss" }, { id: "f2", decision: "skip" }],
    }),
  });
  const record = await (await parked).json();
  const elapsed = Date.now() - started;
  assert.equal(record.tally.discuss, 1);
  assert.ok(elapsed < 5000, `woke in ${elapsed}ms, expected well under 5s`);
});

test("`triago wait` blocks, prints the decisions JSON and exits 0", async () => {
  const posted = await (
    await fetch(`${BASE}/api/cards`, { method: "POST", headers: auth(), body: JSON.stringify(CARD) })
  ).json();

  const wait = spawn(process.execPath, [CLI, "wait", posted.id, "--timeout", "30"], { env });
  let stdout = "";
  wait.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  const exited = new Promise((resolve) => wait.on("exit", resolve));

  await sleep(400);
  await fetch(`${BASE}/api/cards/${posted.id}/decisions`, {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({
      items: [{ id: "f1", decision: "fix" }, { id: "f2", decision: "fix" }],
    }),
  });

  assert.equal(await exited, 0);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.card, posted.id);
  assert.deepEqual(parsed.tally, { fix: 2, skip: 0, discuss: 0, defer: 0 });
});

test("`triago wait` on an undecided card exits 3 so the agent can walk away", async () => {
  const posted = await (
    await fetch(`${BASE}/api/cards`, { method: "POST", headers: auth(), body: JSON.stringify(CARD) })
  ).json();
  const wait = spawn(process.execPath, [CLI, "wait", posted.id, "--timeout", "1"], { env });
  const code = await new Promise((resolve) => wait.on("exit", resolve));
  assert.equal(code, 3);
});

test("cards survive a server restart — disk is the truth", async () => {
  const before = await (await fetch(`${BASE}/api/cards`, { headers: auth() })).json();
  server.kill("SIGTERM");
  await sleep(400);
  server = await startServer();
  const after = await (await fetch(`${BASE}/api/cards`, { headers: auth() })).json();
  assert.equal(after.cards.length, before.cards.length);
  assert.ok(after.cards.length >= 4);
});

test("id prefixes resolve, unknown ids 404", async () => {
  const list = await (await fetch(`${BASE}/api/cards`, { headers: auth() })).json();
  const id = list.cards[0].id;
  const byPrefix = await fetch(`${BASE}/api/cards/${id.slice(0, 5)}`, { headers: auth() });
  assert.equal(byPrefix.status, 200);
  assert.equal((await byPrefix.json()).card.id, id);

  const missing = await fetch(`${BASE}/api/cards/zzzzzzzz`, { headers: auth() });
  assert.equal(missing.status, 404);
});

test("defer is its own decision, distinct from skip, and round-trips to disk", async () => {
  const posted = await (
    await fetch(`${BASE}/api/cards`, { method: "POST", headers: auth(), body: JSON.stringify(CARD) })
  ).json();
  const res = await fetch(`${BASE}/api/cards/${posted.id}/decisions`, {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({
      items: [
        { id: "f1", decision: "defer", comment: "next sprint" },
        { id: "f2", decision: "skip" },
      ],
    }),
  });
  assert.equal(res.status, 200);
  const { decisions } = await res.json();
  assert.deepEqual(decisions.tally, { fix: 0, skip: 1, discuss: 0, defer: 1 });
  assert.equal(decisions.items[0].decision, "defer");
  assert.equal(decisions.items[0].comment, "next sprint");

  const reread = await (await fetch(`${BASE}/api/cards/${posted.id}`, { headers: auth() })).json();
  assert.equal(reread.decisions.items[0].decision, "defer");

  const bogus = await fetch(`${BASE}/api/cards/${posted.id}/decisions`, {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ items: [{ id: "f1", decision: "later" }] }),
  });
  assert.equal(bogus.status, 422, "only the four known verbs are accepted");
});

test("the SSE stream pushes card.created and card.decided", async () => {
  const controller = new AbortController();
  const res = await fetch(`${BASE}/api/events`, {
    headers: { authorization: `Bearer ${token}` },
    signal: controller.signal,
  });
  assert.equal(res.status, 200);

  const events = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const pump = (async () => {
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let split;
      while ((split = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const name = /event:\s*(.+)/.exec(frame)?.[1]?.trim();
        const data = /data:\s*(.+)/.exec(frame)?.[1]?.trim();
        if (name === "change") events.push(JSON.parse(data));
      }
    }
  })();

  const posted = await (
    await fetch(`${BASE}/api/cards`, { method: "POST", headers: auth(), body: JSON.stringify(CARD) })
  ).json();
  await fetch(`${BASE}/api/cards/${posted.id}/decisions`, {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({
      items: [{ id: "f1", decision: "fix" }, { id: "f2", decision: "skip" }],
    }),
  });

  for (let i = 0; i < 40 && events.length < 2; i++) await sleep(50);
  controller.abort();
  await pump.catch(() => {});

  assert.deepEqual(events, [
    { type: "card.created", id: posted.id },
    { type: "card.decided", id: posted.id },
  ]);
});

test("a misspelled API path is a JSON 404, not the SPA shell", async () => {
  const res = await fetch(`${BASE}/api/card/whatever`, { headers: auth() });
  assert.equal(res.status, 404);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);

  const spa = await fetch(`${BASE}/c/anything`);
  assert.equal(spa.status, 200);
  assert.match(spa.headers.get("content-security-policy") ?? "", /script-src 'self'/);
});

test("an ambiguous id prefix says so instead of claiming the card is missing", async () => {
  // Ids are random, so plant two colliding ones on disk to make this deterministic.
  const source = fs.readdirSync(path.join(HOME, "cards"))[0];
  for (const id of ["deadbeef", "deadbe00"]) {
    fs.cpSync(path.join(HOME, "cards", source), path.join(HOME, "cards", id), { recursive: true });
    const file = path.join(HOME, "cards", id, "card.json");
    const card = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(file, JSON.stringify({ ...card, id }, null, 2));
  }

  const ambiguous = await fetch(`${BASE}/api/cards/deadbe`, { headers: auth() });
  assert.equal(ambiguous.status, 409);
  assert.match((await ambiguous.json()).error, /matches 2 cards/);

  const exact = await fetch(`${BASE}/api/cards/deadbeef`, { headers: auth() });
  assert.equal(exact.status, 200, "a full id still wins over the shared prefix");
});

test("`triago wait` on a bad id fails fast instead of burning the whole budget", async () => {
  const started = Date.now();
  const wait = spawn(process.execPath, [CLI, "wait", "nosuchcard", "--timeout", "60"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  wait.stderr.on("data", (c) => {
    stderr += c;
  });
  const code = await new Promise((resolve) => wait.on("exit", resolve));
  const elapsed = Date.now() - started;
  assert.equal(code, 1, "a permanent error is not a timeout");
  assert.match(stderr, /404|no such card/);
  assert.ok(elapsed < 10000, `failed in ${elapsed}ms, expected to give up immediately`);
});

test("editor deep-links stay off until the user opts in", async () => {
  const res = await fetch(`${BASE}/api/open`, {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ file: "a/b.java", line: 1 }),
  });
  assert.equal(res.status, 409);
  assert.match((await res.json()).reason, /disabled/);
});
