/**
 * One schema, three interfaces.
 *
 * Everything triago exchanges is defined here exactly once: the HTTP server
 * validates against these objects at runtime, the MCP tools derive their JSON
 * Schemas from the same shapes, and the frontend imports the inferred types.
 * The three interfaces cannot drift because there is only one definition.
 */
import { z } from "zod";

/** Bumped when the wire format changes incompatibly; drives self-healing respawn. */
export const PROTOCOL = 1;

export const severities = ["critical", "high", "medium", "low", "info"] as const;
export const Severity = z.enum(severities);
export type Severity = z.infer<typeof Severity>;

/**
 * fix     — act on it now.
 * skip    — not a real problem, or not worth doing at all.
 * discuss — needs a conversation before anything happens.
 * defer   — real, but not now: file it as tracked follow-up work and move on.
 *           (`skip` plus a comment used to carry this and lost the distinction
 *           between "not a problem" and "a problem for later".)
 */
export const decisions = ["fix", "skip", "discuss", "defer"] as const;
export const Decision = z.enum(decisions);
export type Decision = z.infer<typeof Decision>;

/** Superset of Claude Code's ReportFindings item, plus review-comment fields. */
export const findingShape = {
  id: z.string().min(1).max(64).optional(),
  severity: Severity.default("medium"),
  verdict: z.string().max(40).optional(),
  category: z.string().max(60).optional(),
  repo: z.string().max(120).optional(),
  file: z.string().max(500).optional(),
  line: z.number().int().nonnegative().optional(),
  summary: z.string().min(1).max(400),
  short_summary: z.string().max(120).optional(),
  body: z.string().max(20000).optional(),
  failure_scenario: z.string().max(20000).optional(),
  suggested_fix: z.string().max(20000).optional(),
  reviewer: z.string().max(120).optional(),
  pr: z.string().max(200).optional(),
  comment_url: z.string().max(500).optional(),
  proposed_action: z.string().max(4000).optional(),
};
/** As posted: the id is optional, triago assigns one when it is missing. */
export const Finding = z.object(findingShape);
export type FindingInput = z.input<typeof Finding>;

/** As persisted: id and severity are always present. */
export const StoredFinding = Finding.extend({ id: z.string().min(1).max(64) });
export type StoredFinding = z.infer<typeof StoredFinding>;

const cardBaseShape = {
  title: z.string().min(1).max(200),
  source: z.string().max(120).optional(),
  session: z.string().max(120).optional(),
  cwd: z.string().max(1000).optional(),
  tmux_pane: z.string().max(60).optional(),
};

export const findingsCardShape = {
  ...cardBaseShape,
  findings: z.array(Finding).min(1).max(500),
  group_by: z.enum(["severity", "repo", "none"]).default("severity"),
};

export const docCardShape = {
  ...cardBaseShape,
  markdown: z.string().min(1).max(400000),
  ack_label: z.string().max(40).optional(),
};

export const FindingsCardInput = z.object({ type: z.literal("findings"), ...findingsCardShape });
export const DocCardInput = z.object({ type: z.literal("doc"), ...docCardShape });
export const CardInput = z.discriminatedUnion("type", [FindingsCardInput, DocCardInput]);
export type CardInput = z.infer<typeof CardInput>;

const storedMeta = {
  id: z.string(),
  created_at: z.string(),
  status: z.enum(["open", "decided"]),
  decided_at: z.string().optional(),
};

export const StoredFindingsCard = FindingsCardInput.extend({
  ...storedMeta,
  findings: z.array(StoredFinding).min(1).max(500),
});
export const StoredDocCard = DocCardInput.extend(storedMeta);
export const StoredCard = z.discriminatedUnion("type", [StoredFindingsCard, StoredDocCard]);
export type StoredCard = z.infer<typeof StoredCard>;
export type StoredFindingsCard = z.infer<typeof StoredFindingsCard>;
export type StoredDocCard = z.infer<typeof StoredDocCard>;

export const CardSummary = z.object({
  id: z.string(),
  type: z.enum(["findings", "doc"]),
  title: z.string(),
  source: z.string().optional(),
  session: z.string().optional(),
  status: z.enum(["open", "decided"]),
  created_at: z.string(),
  decided_at: z.string().optional(),
  open_items: z.number(),
  total_items: z.number(),
});
export type CardSummary = z.infer<typeof CardSummary>;

export const decisionItemShape = {
  id: z.string().min(1).max(64),
  decision: Decision,
  comment: z.string().max(4000).optional(),
};
export const DecisionItem = z.object(decisionItemShape);
export type DecisionItem = z.infer<typeof DecisionItem>;

export const DecisionsInput = z.object({
  items: z.array(DecisionItem).default([]),
  global_comment: z.string().max(8000).optional(),
  acknowledged: z.boolean().optional(),
});
export type DecisionsInput = z.infer<typeof DecisionsInput>;

export const Tally = z.object({
  fix: z.number(),
  skip: z.number(),
  discuss: z.number(),
  defer: z.number(),
});
export type Tally = z.infer<typeof Tally>;

/** What the agent gets back — the loop-closure payload. */
export const DecisionsRecord = z.object({
  card: z.string(),
  card_title: z.string(),
  type: z.enum(["findings", "doc"]),
  decided_at: z.string(),
  tally: Tally,
  global_comment: z.string().optional(),
  acknowledged: z.boolean().optional(),
  items: z.array(
    DecisionItem.extend({
      summary: z.string().optional(),
      file: z.string().optional(),
      line: z.number().optional(),
      comment_url: z.string().optional(),
    }),
  ),
});
export type DecisionsRecord = z.infer<typeof DecisionsRecord>;

export const Health = z.object({
  ok: z.literal(true),
  name: z.literal("triago"),
  version: z.string(),
  protocol: z.number(),
  pid: z.number(),
  started_at: z.string(),
  home: z.string(),
});
export type Health = z.infer<typeof Health>;

export function tallyOf(items: readonly { decision: Decision }[]): Tally {
  const t: Tally = { fix: 0, skip: 0, discuss: 0, defer: 0 };
  for (const i of items) t[i.decision]++;
  return t;
}
