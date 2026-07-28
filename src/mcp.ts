#!/usr/bin/env node
/**
 * MCP adapter — triago's primary interface for agents that speak MCP.
 *
 * The tools are a thin shell over the same HTTP API the CLI uses, and their
 * JSON Schemas are generated from the zod shapes in schema.ts, so an agent and
 * a human are always looking at the same card contract.
 *
 * Blocking by design: post → the tool call parks until Submit → the decisions
 * JSON *is* the tool result, so the agent needs no ladder. Clients cap tool
 * calls (Claude Code defaults to ~60s), so the default park is short and a
 * timeout hands back a card id for `triago_await_decisions` to pick up. Raise
 * MCP_TOOL_TIMEOUT (e.g. 600000) to park for the whole triage instead.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ensureServer, waitForDecisions } from "./client.js";
import { DEFAULT_PORT, version } from "./paths.js";
import { CardInput, Finding, decisions } from "./schema.js";

const waitSeconds = z
  .number()
  .int()
  .min(0)
  .max(600)
  .default(45)
  .describe("Seconds to park waiting for the human. 0 returns immediately with the card id.");

const context = {
  source: z.string().max(120).optional().describe("What produced this card, e.g. /code-review"),
  session: z
    .string()
    .max(120)
    .optional()
    .describe("Groups cards in the sidebar — a ticket key or branch name"),
};

type Json = Record<string, unknown>;

const text = (payload: Json): { content: [{ type: "text"; text: string }] } => ({
  content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
});

async function postAndMaybeWait(input: CardInput, seconds: number): Promise<Json> {
  const client = await ensureServer(DEFAULT_PORT);
  const posted = await client.postCard(input);
  if (seconds === 0) {
    return { status: "posted", card_id: posted.id, url: posted.url };
  }
  const record = await waitForDecisions(posted.id, seconds, DEFAULT_PORT);
  if (record) return { status: "decided", ...record };
  return {
    status: "pending",
    card_id: posted.id,
    url: posted.url,
    hint:
      `Human has not submitted yet — this is normal, a real triage outlasts this call. ` +
      `End your turn and say the card is open. Do not sit in a polling loop: you would burn the ` +
      `turn waiting and lose it anyway when the session ends. Next time you are invoked, call ` +
      `triago_await_decisions with card_id "${posted.id}" and wait_seconds 0 — it returns at once ` +
      `with the decisions if they are in, and costs nothing if they are not.`,
  };
}

/** Joined from the schema, so a new decision verb cannot go unmentioned here. */
const VERBS = decisions.join(" / ");

/**
 * Shipped with the server rather than left to each user's instruction file.
 *
 * A tool the model has to be *told* to reach for in CLAUDE.md or AGENTS.md only
 * works for whoever wrote that file. Clients surface `instructions` to the model
 * before it sees a single tool call, so the policy — when a card is warranted,
 * and what each decision obliges — travels with the install.
 */
const INSTRUCTIONS = `triago shows the human a browser card built from a list you produced, collects a
decision on every item, and returns those decisions to you as structured data.

It exists because a terminal can neither present a long list with hierarchy nor
collect a response per item. Printed lists get skimmed or accepted wholesale,
which is exactly where per-item judgment matters most.

When to use it:
- More than about five findings, review comments, or proposed changes: call
  triago_post_findings instead of printing them.
- A judgment document over roughly 80 lines — a design write-up, an impact
  analysis, an RCA draft: call triago_post_doc instead of printing it.
- Short output, a single question, or anything needing no per-item response:
  stay in the terminal. Do not post a card for those.

What each returned decision obliges you to do:
- fix — act on it. If the code is yours, make the change now, in this session.
  If you are reviewing someone else's work, acting on it means raising it where
  the review lives — a comment on their pull request — never editing their
  branch.
- skip — drop it; do not raise it again for this change.
- discuss — the human has something to say about this one before you act.
- defer — real, but out of scope for now: record it as tracked follow-up work.
  Never silently treat a defer as a skip.

Whose code it is decides where a fix goes, so settle that before you post, not
after. Reviewing someone else's pull request is the case that catches agents
out: the findings are yours, the branch is not, and offering to "fix" them is a
promise to edit code you have no business touching. Say which of the two you are
doing when you hand the card over, so the human is deciding against the right
question.

Read the comment before acting on the verb. The comment is the substance; the
verb only says how to file it. A discuss carrying a comment is the human's
answer, not a request for a meeting — act on what it says. Only an empty discuss
means stop and ask.

Most comments on a review are corrections. Someone who knows the system will
tell you the premise was wrong, the code is out of scope, or a constraint you
could not see makes the finding moot. Treat that as authoritative: withdraw the
finding rather than defending it, and check whether the same correction also
invalidates neighbouring findings you raised for the same reason. Do not
re-raise a corrected item later in the session.

The card's global comment applies to every item without one of its own.

Picking a card back up:
A real triage takes longer than this tool call, so a timeout is the normal
outcome, not a failure. When it happens, end your turn and tell the human the
card is open. Do not poll in a loop — you would spend the turn waiting, block
yourself from doing anything else, and lose the loop the moment the session
ends. The decisions are on disk and will keep.

Instead, pick it up on your next turn, whoever prompts it and whenever that is:
call triago_await_decisions with the card id and wait_seconds 0. It answers
immediately — with the decisions if they are in, and at no cost if they are not.
Do that before anything else while a card of yours is outstanding, so the human
never has to ask you to go and look. If you have lost the id, or you are a new
session that did not post the card, triago_list_cards finds it.

If a card cannot be posted, print the list in the terminal instead — never
discard it. Nothing is lost either way, because cards and decisions are files on
the human's own disk.`;

const server = new McpServer(
  { name: "triago", version: version() },
  { instructions: INSTRUCTIONS },
);

server.registerTool(
  "triago_post_findings",
  {
    title: "Post findings for triage",
    description: `Post a list of review findings to the triago browser surface and get the human's per-item decisions back. Prefer this over printing more than about five findings in the terminal: the human triages each item as ${VERBS} with optional comments, and the tool returns those decisions as structured data. Each decision obliges a specific follow-up — act on a fix (edit it where the code is yours, raise it on the pull request where it is not), drop a skip, stop and ask on a discuss, and record a defer as tracked follow-up work rather than dropping it.`,
    inputSchema: {
      title: z
        .string()
        .min(1)
        .max(200)
        .describe("Card title, e.g. 'Code review — api-server @ feature/rate-limit'"),
      findings: z
        .array(z.object(Finding.shape))
        .min(1)
        .max(500)
        .describe("One entry per finding; summary is required, everything else optional"),
      group_by: z.enum(["severity", "repo", "none"]).default("severity"),
      ...context,
      wait_seconds: waitSeconds,
    },
  },
  async ({ title, findings, group_by, source, session, wait_seconds }) =>
    text(
      await postAndMaybeWait(
        {
          type: "findings",
          title,
          findings,
          group_by,
          ...(source ? { source } : {}),
          ...(session ? { session } : {}),
          cwd: process.cwd(),
        },
        wait_seconds,
      ),
    ),
);

server.registerTool(
  "triago_post_doc",
  {
    title: "Post a document to read",
    description:
      "Post markdown (a design write-up, an impact analysis, a plan) to the triago browser surface for comfortable reading, and wait for the human to acknowledge it with an optional comment. Prefer this over printing a judgment document longer than roughly 80 lines into the terminal.",
    inputSchema: {
      title: z.string().min(1).max(200),
      markdown: z.string().min(1).max(400000),
      ack_label: z.string().max(40).optional().describe("Button label, defaults to 'Acknowledge'"),
      ...context,
      wait_seconds: waitSeconds,
    },
  },
  async ({ title, markdown, ack_label, source, session, wait_seconds }) =>
    text(
      await postAndMaybeWait(
        {
          type: "doc",
          title,
          markdown,
          ...(ack_label ? { ack_label } : {}),
          ...(source ? { source } : {}),
          ...(session ? { session } : {}),
          cwd: process.cwd(),
        },
        wait_seconds,
      ),
    ),
);

server.registerTool(
  "triago_await_decisions",
  {
    title: "Wait for decisions on a card",
    description:
      "Keep waiting for a card the human has not submitted yet. Safe to call repeatedly; returns immediately once decisions exist.",
    inputSchema: {
      card_id: z.string().min(1).max(64),
      wait_seconds: waitSeconds,
    },
  },
  async ({ card_id, wait_seconds }) => {
    const record = await waitForDecisions(card_id, wait_seconds, DEFAULT_PORT);
    return text(record ? { status: "decided", ...record } : { status: "pending", card_id });
  },
);

server.registerTool(
  "triago_list_cards",
  {
    title: "List triago cards",
    description:
      "List cards posted to triago, newest last, with how many items are still undecided.",
    inputSchema: {
      session: z.string().max(120).optional(),
      open_only: z.boolean().default(false),
    },
  },
  async ({ session, open_only }) => {
    const client = await ensureServer(DEFAULT_PORT);
    const { cards } = await client.listCards(session);
    return text({ cards: open_only ? cards.filter((c) => c.status === "open") : cards });
  },
);

await server.connect(new StdioServerTransport());
