import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  CardInput,
  CardSummary,
  DecisionsInput,
  DecisionsRecord,
  StoredCard,
  tallyOf,
} from "./schema.js";
import { CARDS_DIR, cardDir, ensureHome } from "./paths.js";

/**
 * Disk is the truth; the server is a stateless view over it. A crash loses
 * nothing but in-flight long-polls, which the CLI re-issues.
 */

function writeAtomic(file: string, data: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function newId(): string {
  return randomBytes(4).toString("hex");
}

export function createCard(input: CardInput): StoredCard {
  ensureHome();
  let id = newId();
  while (fs.existsSync(cardDir(id))) id = newId();

  const base = {
    ...input,
    id,
    created_at: new Date().toISOString(),
    status: "open" as const,
  };
  const card: StoredCard =
    base.type === "findings"
      ? {
          ...base,
          findings: base.findings.map((f, i) => ({ ...f, id: f.id ?? `f${i + 1}` })),
        }
      : base;

  fs.mkdirSync(cardDir(id), { recursive: true, mode: 0o700 });
  writeAtomic(path.join(cardDir(id), "card.json"), JSON.stringify(card, null, 2));
  return card;
}

export function readCard(id: string): StoredCard | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(cardDir(id), "card.json"), "utf8"));
    const parsed = StoredCard.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function readDecisions(id: string): DecisionsRecord | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(cardDir(id), "decisions.json"), "utf8"));
    const parsed = DecisionsRecord.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function listCardIds(): string[] {
  try {
    return fs
      .readdirSync(CARDS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

export function summarize(card: StoredCard): CardSummary {
  const decisions = readDecisions(card.id);
  const total = card.type === "findings" ? card.findings.length : 1;
  const decided = decisions ? (card.type === "findings" ? decisions.items.length : 1) : 0;
  return {
    id: card.id,
    type: card.type,
    title: card.title,
    source: card.source,
    session: card.session,
    status: card.status,
    created_at: card.created_at,
    decided_at: card.decided_at,
    open_items: Math.max(0, total - decided),
    total_items: total,
  };
}

export function listCards(session?: string): CardSummary[] {
  const cards = listCardIds()
    .map(readCard)
    .filter((c): c is StoredCard => c !== null)
    .filter((c) => !session || c.session === session);
  cards.sort((a, b) => a.created_at.localeCompare(b.created_at));
  return cards.map(summarize);
}

export type Lookup =
  { ok: true; card: StoredCard } | { ok: false; status: 404 | 409; error: string };

/**
 * Accepts a full id or an unambiguous prefix, so ids stay hand-typable. An
 * ambiguous prefix is reported as such rather than as a missing card, which
 * would send the human looking for the wrong problem.
 */
export function lookupCard(prefix: string): Lookup {
  const exact = fs.existsSync(cardDir(prefix)) ? prefix : null;
  const id = exact ?? matchPrefix(prefix);
  if (typeof id !== "string") return id;
  const card = readCard(id);
  return card ? { ok: true, card } : { ok: false, status: 404, error: `card ${id} is unreadable` };
}

function matchPrefix(prefix: string): string | Extract<Lookup, { ok: false }> {
  const matches = listCardIds().filter((id) => id.startsWith(prefix));
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) return { ok: false, status: 404, error: "no such card" };
  return {
    ok: false,
    status: 409,
    error: `id prefix "${prefix}" matches ${matches.length} cards: ${matches.join(", ")}`,
  };
}

export class DecisionError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/**
 * Removes a card and its decisions from disk. Returns false if it was already
 * gone, so deleting twice is not an error. Callers must wake anything parked on
 * the card first, or a blocked `--wait` sits there until its own timeout with
 * no idea the card no longer exists — see killWaiters in server.ts.
 */
export function deleteCard(id: string): boolean {
  const dir = cardDir(id);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

export function submitDecisions(card: StoredCard, input: DecisionsInput): DecisionsRecord {
  if (card.status === "decided") throw new DecisionError("card already decided", 409);

  let items: DecisionsRecord["items"] = [];
  if (card.type === "findings") {
    const byId = new Map(card.findings.map((f) => [f.id, f]));
    for (const item of input.items) {
      if (!byId.has(item.id)) throw new DecisionError(`unknown finding id: ${item.id}`);
    }
    const seen = new Set(input.items.map((i) => i.id));
    const missing = card.findings.filter((f) => !seen.has(f.id)).map((f) => f.id);
    if (missing.length) {
      throw new DecisionError(`undecided findings: ${missing.join(", ")}`);
    }
    items = input.items.map((item) => {
      const f = byId.get(item.id)!;
      return {
        ...item,
        summary: f.summary,
        ...(f.file ? { file: f.file } : {}),
        ...(f.line !== undefined ? { line: f.line } : {}),
        ...(f.comment_url ? { comment_url: f.comment_url } : {}),
      };
    });
  }

  const record: DecisionsRecord = {
    card: card.id,
    card_title: card.title,
    type: card.type,
    decided_at: new Date().toISOString(),
    tally: tallyOf(items),
    ...(input.global_comment ? { global_comment: input.global_comment } : {}),
    ...(card.type === "doc" ? { acknowledged: input.acknowledged ?? true } : {}),
    items,
  };

  writeAtomic(path.join(cardDir(card.id), "decisions.json"), JSON.stringify(record, null, 2));
  const closed: StoredCard = { ...card, status: "decided", decided_at: record.decided_at };
  writeAtomic(path.join(cardDir(card.id), "card.json"), JSON.stringify(closed, null, 2));
  return record;
}

/**
 * Two facts about a card that nothing else records, both about silence.
 *
 * A card can be posted, never open a tab, and sit unnoticed; decisions can be
 * submitted with nothing listening and sit uncollected. Both are invisible in
 * the moment — that is what makes them worth counting. They are marker files in
 * the card's own directory rather than fields on the card, because the card is
 * agent-authored content and this is not, and because deleting a card should
 * take its bookkeeping with it.
 */
const MARKERS = { opened: "opened", delivered: "delivered" } as const;

function mark(id: string, name: string): void {
  try {
    fs.writeFileSync(path.join(cardDir(id), name), "");
  } catch {
    /* bookkeeping must never break the thing it is counting */
  }
}

function marked(id: string, name: string): boolean {
  return fs.existsSync(path.join(cardDir(id), name));
}

/** A browser tab was actually opened for this card. */
export function markOpened(id: string): void {
  mark(id, MARKERS.opened);
}

/** Decisions were handed to something that was parked waiting for them. */
export function markDelivered(id: string): void {
  mark(id, MARKERS.delivered);
}

export type HomeStats = {
  total: number;
  open: number;
  decided: number;
  /** Open, and no tab was ever opened for it — nobody has necessarily seen it. */
  openUnseen: number;
  /** Decided, but nothing was waiting when it was submitted. */
  undelivered: number;
};

export function homeStats(): HomeStats {
  const stats: HomeStats = { total: 0, open: 0, decided: 0, openUnseen: 0, undelivered: 0 };
  for (const id of listCardIds()) {
    const card = readCard(id);
    if (!card) continue;
    stats.total++;
    if (card.status === "open") {
      stats.open++;
      if (!marked(id, MARKERS.opened)) stats.openUnseen++;
    } else {
      stats.decided++;
      if (!marked(id, MARKERS.delivered)) stats.undelivered++;
    }
  }
  return stats;
}
