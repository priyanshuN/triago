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
import { CardInput, Finding } from "./schema.js";

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
    hint: `Human has not submitted yet. Call triago_await_decisions with card_id "${posted.id}" to keep waiting, or end your turn and read it later.`,
  };
}

const server = new McpServer({ name: "triago", version: version() });

server.registerTool(
  "triago_post_findings",
  {
    title: "Post findings for triage",
    description:
      "Post a list of review findings to the triago browser surface and get the human's per-item decisions back. Use this instead of printing a long findings list in the terminal: the human triages each item as fix / skip / discuss with optional comments, and the tool returns those decisions as structured data.",
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
      "Post markdown (a design write-up, an impact analysis, a plan) to the triago browser surface for comfortable reading, and wait for the human to acknowledge it with an optional comment.",
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
    description: "List cards posted to triago, newest last, with how many items are still undecided.",
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
