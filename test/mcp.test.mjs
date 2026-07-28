/**
 * MCP tests: speak JSON-RPC to the stdio adapter the way a real client does.
 *
 * The point is not that the SDK works — it is that the tool schemas are the ones
 * generated from src/schema.ts, and that a post through MCP lands as a card the
 * browser and the CLI can see. That is the seam where agent, human and server
 * can silently disagree.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
// The built schema is the source of truth for the decision verbs, so these
// assertions grow automatically when a verb is added.
import { decisions } from "../dist/schema.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5694;
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "triago-mcp-test-"));
// TRIAGO_NO_BROWSER is not optional here: without it every card posted by these
// tests opens a real browser tab.
const env = {
  ...process.env,
  TRIAGO_HOME: HOME,
  TRIAGO_PORT: String(PORT),
  TRIAGO_NO_BROWSER: "1",
};

let proc;
let nextId = 0;
let initResult;
const pending = new Map();

function rpc(method, params) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    const timer = setTimeout(() => reject(new Error(`timeout on ${method}`)), 20000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

before(async () => {
  assert.ok(fs.existsSync(path.join(ROOT, "dist", "mcp.js")), "run `npm run build` first");
  proc = spawn(process.execPath, [path.join(ROOT, "dist", "mcp.js")], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  proc.stdout.on("data", (chunk) => {
    buffer += chunk;
    let split;
    while ((split = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, split).trim();
      buffer = buffer.slice(split + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const resolve = msg.id && pending.get(msg.id);
      if (resolve) {
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  });

  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "triago-test", version: "1" },
  });
  assert.equal(init.result.serverInfo.name, "triago");
  initResult = init.result;
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
});

after(async () => {
  proc?.kill();
  await new Promise((r) => setTimeout(r, 200));
  // the shim spawned a server on PORT; stop it so the test leaves nothing behind
  try {
    const token = fs.readFileSync(path.join(HOME, "token"), "utf8").trim();
    await fetch(`http://127.0.0.1:${PORT}/api/shutdown`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
  } catch {
    /* already gone */
  }
  fs.rmSync(HOME, { recursive: true, force: true });
});

// The trigger surface is the product here: an agent decides whether to post a
// card from these strings alone. `defer` shipped for a week missing from the
// findings description because both were hand-written, so both are now asserted
// against the schema's own list of decisions.
test("the server ships instructions saying when to post and what each decision obliges", () => {
  const instructions = initResult.instructions ?? "";
  assert.ok(instructions.length > 200, "instructions must carry the policy, not a tagline");
  for (const verb of decisions) {
    assert.match(instructions, new RegExp(`\\b${verb}\\b`), `instructions never mention "${verb}"`);
  }
  assert.match(instructions, /five|5/, "no threshold for when a card is warranted");
  assert.match(instructions, /terminal/, "never says what to do with short output");
});

/**
 * The first real review through this tool came back 9 discuss / 1 fix, and every
 * discuss carried a comment that was an *answer* — the premise is wrong, that
 * code is out of scope, that cannot happen while assigned. The instructions at
 * the time defined discuss as "stop and bring it back to the human", so an agent
 * following them would have gone back to ask nine questions that had already
 * been answered in front of it.
 *
 * The verb says how to file the item; the comment says what to do. If that ever
 * stops being spelled out, the tool starts talking past the human at exactly the
 * point where they took the trouble to explain something.
 */
/**
 * The first card posted by an agent that chose to on its own was a review of a
 * pull request the human did not write — they were the reviewer, not the author.
 * It closed with an offer to act on the fix items, which was faithful to the
 * policy at the time ("act on it now, in this session") and impossible: there
 * was no branch it had any business editing.
 *
 * The four verbs are right; what was missing was the addressee. A fix on your
 * own code is an edit, a fix on someone else's is a review comment, and an agent
 * that cannot tell the two apart either does nothing or does something worse.
 */
test("the instructions say where a fix goes when the code is not the agent's", () => {
  const instructions = initResult.instructions ?? "";
  assert.match(
    instructions,
    /someone else'?s|not yours|do not own/i,
    "never acknowledges reviewing code the human did not write",
  );
  assert.match(
    instructions,
    /pull request/i,
    "never names where a finding goes when there is no branch to edit",
  );
  assert.match(
    instructions,
    // \s+ not a literal space: the policy is hand-wrapped at 80 columns, so any
    // phrase long enough to matter can have a newline dropped into the middle of
    // it by a later reflow.
    /never\s+editing\s+their\s+branch/i,
    "does not rule out editing someone else's branch",
  );
});

test("the instructions tell the agent the comment outranks the verb", () => {
  const instructions = initResult.instructions ?? "";
  assert.match(instructions, /comment/i, "never mentions comments at all");
  assert.match(
    instructions,
    /comment[\s\S]{0,120}(substance|before acting|answer)/i,
    "does not say the comment carries the substance",
  );
  assert.match(
    instructions,
    /(withdraw|corrections?|authoritative)/i,
    "does not tell the agent to take a correction rather than defend the finding",
  );
});

test("every decision verb appears in the findings tool description", async () => {
  const { result } = await rpc("tools/list", {});
  const description = result.tools.find((t) => t.name === "triago_post_findings").description;
  for (const verb of decisions) {
    assert.match(description, new RegExp(`\\b${verb}\\b`), `description omits "${verb}"`);
  }
});

test("the four tools are advertised", async () => {
  const { result } = await rpc("tools/list", {});
  assert.deepEqual(result.tools.map((t) => t.name).sort(), [
    "triago_await_decisions",
    "triago_list_cards",
    "triago_post_doc",
    "triago_post_findings",
  ]);
});

test("triago_post_findings' schema is the one generated from schema.ts", async () => {
  const { result } = await rpc("tools/list", {});
  const tool = result.tools.find((t) => t.name === "triago_post_findings");
  assert.deepEqual(tool.inputSchema.required, ["title", "findings"]);

  const item = tool.inputSchema.properties.findings.items;
  assert.deepEqual(item.required, ["summary"], "only summary is mandatory on a finding");
  for (const field of [
    "severity",
    "verdict",
    "file",
    "line",
    "failure_scenario",
    "suggested_fix",
    "comment_url",
  ]) {
    assert.ok(field in item.properties, `finding schema is missing ${field}`);
  }
  assert.deepEqual(item.properties.severity.enum, ["critical", "high", "medium", "low", "info"]);
});

test("a post through MCP creates a card the HTTP API can read", async () => {
  const { result } = await rpc("tools/call", {
    name: "triago_post_findings",
    arguments: {
      title: "From MCP",
      source: "mcp-test",
      session: "MCP-1",
      wait_seconds: 0,
      findings: [{ severity: "high", summary: "posted over stdio", file: "x.ts", line: 3 }],
    },
  });
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.status, "posted");
  assert.match(payload.card_id, /^[0-9a-f]{8}$/);

  const token = fs.readFileSync(path.join(HOME, "token"), "utf8").trim();
  const res = await fetch(`http://127.0.0.1:${PORT}/api/cards/${payload.card_id}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 200);
  const { card } = await res.json();
  assert.equal(card.title, "From MCP");
  assert.equal(card.findings[0].summary, "posted over stdio");
  assert.equal(card.findings[0].id, "f1", "triago assigns ids the human can decide against");
});

test("triago_await_decisions returns pending rather than hanging forever", async () => {
  const listed = await rpc("tools/call", {
    name: "triago_list_cards",
    arguments: { session: "MCP-1", open_only: true },
  });
  const { cards } = JSON.parse(listed.result.content[0].text);
  assert.equal(cards.length, 1);

  const awaited = await rpc("tools/call", {
    name: "triago_await_decisions",
    arguments: { card_id: cards[0].id, wait_seconds: 1 },
  });
  const payload = JSON.parse(awaited.result.content[0].text);
  assert.equal(payload.status, "pending");
  assert.equal(payload.card_id, cards[0].id);
});

/**
 * The zero-second check, which the shipped policy names as the thing to run at
 * the top of every turn while a card is outstanding.
 *
 * It was a no-op, for the least visible reason available: waitForDecisions
 * guarded its polling loop with `while (Date.now() < deadline)`, and a deadline
 * of `now + 0` is already in the past, so the body never ran and nothing ever
 * asked the server. Every zero-wait call answered "pending" — including for
 * cards decided hours earlier. The suite missed it because every other test
 * waits with a real duration, so the one value the instructions actually
 * recommend was the one value never exercised. An agent following the policy
 * would never collect a decision it had not synchronously blocked for.
 */
test("wait_seconds 0 reads a decided card rather than always reporting pending", async () => {
  const posted = await rpc("tools/call", {
    name: "triago_post_findings",
    arguments: {
      title: "Zero-wait pickup",
      session: "MCP-ZERO",
      wait_seconds: 0,
      findings: [{ severity: "low", summary: "decide me" }],
    },
  });
  const { card_id } = JSON.parse(posted.result.content[0].text);

  const before = await rpc("tools/call", {
    name: "triago_await_decisions",
    arguments: { card_id, wait_seconds: 0 },
  });
  assert.equal(
    JSON.parse(before.result.content[0].text).status,
    "pending",
    "an undecided card must still answer pending, and without waiting",
  );

  const token = fs.readFileSync(path.join(HOME, "token"), "utf8").trim();
  const res = await fetch(`http://127.0.0.1:${PORT}/api/cards/${card_id}/decisions`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ items: [{ id: "f1", decision: "fix" }] }),
  });
  assert.equal(res.status, 200);

  const after = await rpc("tools/call", {
    name: "triago_await_decisions",
    arguments: { card_id, wait_seconds: 0 },
  });
  const payload = JSON.parse(after.result.content[0].text);
  assert.equal(payload.status, "decided", "a decided card must come back on a zero-second check");
  assert.equal(payload.tally.fix, 1);
});

/**
 * The resume protocol, which is the whole async half of the product.
 *
 * A real triage outlasts the tool call that posted the card, so a timeout is the
 * normal ending. The two ways to get that wrong are opposite: sit in a polling
 * loop (burns the turn, blocks the agent, dies with the session) or forget the
 * card entirely and leave the human to notice and ask. The instructions have to
 * rule out the first and specify the second, including the zero-second call that
 * makes checking free.
 */
test("the instructions rule out polling and specify how to resume", () => {
  const instructions = initResult.instructions ?? "";
  assert.match(
    instructions,
    /do not poll|not poll in a loop/i,
    "never warns against a polling loop",
  );
  assert.match(
    instructions,
    /wait_seconds 0|wait_seconds: 0/i,
    "never gives the free instant check",
  );
  assert.match(instructions, /next turn/i, "never says when to pick the card back up");
  assert.match(instructions, /triago_list_cards/, "no recovery path for a lost card id");
});
