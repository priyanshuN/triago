#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { TriagoClient, ensureServer, probe, waitForDecisions } from "./client.js";
import { loadConfig } from "./config.js";
import { formatClock } from "./format.js";
import { DEFAULT_PORT, DIST_DIR, TRIAGO_HOME, readToken, version } from "./paths.js";
import { CardInput, DecisionsRecord, Finding, StoredCard } from "./schema.js";
import { startServer } from "./server.js";
import { openBrowser } from "./side.js";
import { homeStats, lookupCard, markOpened } from "./store.js";

const USAGE = `triago — decision surface for CLI agents

  triago findings <file.json|->   post a findings card for triage
  triago doc <file.md|->          post a markdown card to read and acknowledge
  triago demo                     post a sample findings card (try it in one command)
  triago wait <id>                block until submitted (exit 3 on timeout)
  triago show <id>                print a card and its decisions
  triago ls                       list cards
  triago open [id]                open the browser surface (hands over the token)
  triago rm <id…>                 delete cards (--force for ones still open)
  triago prune                    bulk delete; prints the list, --yes to do it
  triago status                   is the server up, and where
  triago stop                     shut the server down
  triago token                    print the API token
  triago serve                    run the server in the foreground
  triago --version                print the version and exit

Common flags
  --title <t>       card title            --session <k>  session key (default: git branch)
  --source <s>      what produced it      --wait [secs]  block and print decisions JSON
  --group-by <g>    severity|repo|none    --json         machine-readable output
  --timeout <secs>  wait budget (540)     --ack-label <t> doc card button label

Prune flags
  --older-than <days>  only cards created before then    --include-open  open ones too
  --session <k>        only that session                 --yes           actually delete

Payloads accept either {title?, findings:[...]} or a bare array of findings.
State lives in ${TRIAGO_HOME}. Nothing leaves the machine.`;

type Args = { _: string[]; flags: Record<string, string | boolean> };

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      out._.push(arg);
      continue;
    }
    const [rawKey, inlineValue] = arg.slice(2).split(/=(.*)/s);
    const key = rawKey!;
    if (inlineValue !== undefined) {
      out.flags[key] = inlineValue;
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out.flags[key] = next;
      i++;
    } else {
      out.flags[key] = true;
    }
  }
  return out;
}

const str = (v: string | boolean | undefined): string | undefined =>
  typeof v === "string" ? v : undefined;

function fail(message: string, code = 1): never {
  process.stderr.write(`triago: ${message}\n`);
  process.exit(code);
}

function readInput(file: string | undefined): string {
  if (!file || file === "-") return fs.readFileSync(0, "utf8");
  if (!fs.existsSync(file)) fail(`no such file: ${file}`, 2);
  return fs.readFileSync(file, "utf8");
}

function gitBranch(from: string): string | null {
  let dir = path.resolve(from);
  for (let i = 0; i < 12; i++) {
    const dotGit = path.join(dir, ".git");
    try {
      // Read .git straight away rather than stat-ing it and then reading it. A
      // worktree or submodule has a .git *file* pointing elsewhere, an ordinary
      // repository has a directory, and attempting the read tells them apart (a
      // directory fails with EISDIR) without the gap a stat-then-read leaves
      // between deciding what the path is and acting on it.
      let gitDir = dotGit;
      let pointerText: string | null = null;
      try {
        pointerText = fs.readFileSync(dotGit, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EISDIR") throw err;
      }
      if (pointerText !== null) {
        const pointer = pointerText.match(/gitdir:\s*(.+)/);
        if (!pointer) return null;
        gitDir = path.resolve(dir, pointer[1]!.trim());
      }
      const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
      const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/);
      return ref ? ref[1]! : head.slice(0, 8);
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }
  return null;
}

/** Session key: explicit flag, then env, then the ticket-ish part of the git branch. */
function inferSession(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.TRIAGO_SESSION) return process.env.TRIAGO_SESSION;
  const branch = gitBranch(process.cwd());
  if (branch) {
    const match = new RegExp(loadConfig().session_regex).exec(branch);
    return match ? match[0] : branch;
  }
  return path.basename(process.cwd());
}

function cardContext(args: Args): { session: string; cwd: string; tmux_pane?: string } {
  return {
    session: inferSession(str(args.flags.session)),
    cwd: process.cwd(),
    ...(process.env.TMUX_PANE ? { tmux_pane: process.env.TMUX_PANE } : {}),
  };
}

function printPosted(
  posted: { id: string; url: string; opened_browser: boolean; browser?: string },
  kind: string,
  items: number,
): void {
  const out = process.stderr;
  out.write(`triago · card ${posted.id} · ${kind} · ${items} item${items === 1 ? "" : "s"}\n`);
  out.write(`  open   ${posted.url}\n`);
  out.write(`  wait   triago wait ${posted.id}\n`);
  if (!posted.opened_browser) {
    out.write(`  no tab opened (${posted.browser ?? "suppressed"}) — triago open ${posted.id}\n`);
  }
}

async function maybeWait(id: string, args: Args): Promise<void> {
  const wait = args.flags.wait;
  if (!wait) return;
  const seconds = Number(str(wait) ?? str(args.flags.timeout) ?? 540) || 540;
  const record = await waitForDecisions(id, seconds);
  if (!record) {
    process.stderr.write(`triago: still undecided after ${seconds}s — later: triago wait ${id}\n`);
    process.exit(3);
  }
  process.stdout.write(JSON.stringify(record, null, 2) + "\n");
}

async function cmdFindings(args: Args): Promise<void> {
  const raw = readInput(args._[1]);
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    fail(`payload is not valid JSON: ${(err as Error).message}`, 2);
  }
  const asObject = (payload ?? {}) as Record<string, unknown>;
  const rawFindings = Array.isArray(payload) ? payload : asObject.findings;
  if (!Array.isArray(rawFindings) || rawFindings.length === 0) {
    fail("payload must be an array of findings or {findings: [...]}", 2);
  }
  const findings = rawFindings.map((f, i) => {
    const parsed = Finding.safeParse(f);
    if (!parsed.success) {
      fail(
        `finding #${i + 1}: ${parsed.error.issues
          .map((x) => `${x.path.join(".") || "(root)"} ${x.message}`)
          .join("; ")}`,
        2,
      );
    }
    return parsed.data;
  });

  const anySeverity = rawFindings.some(
    (f) => typeof f === "object" && f !== null && "severity" in (f as object),
  );
  const groupBy = (str(args.flags["group-by"]) ?? (anySeverity ? "severity" : "none")) as
    "severity" | "repo" | "none";
  const source =
    str(args.flags.source) ?? (typeof asObject.source === "string" ? asObject.source : undefined);

  const input: CardInput = {
    type: "findings",
    ...cardContext(args),
    ...(source ? { source } : {}),
    title:
      str(args.flags.title) ??
      (typeof asObject.title === "string" ? asObject.title : undefined) ??
      `Findings — ${findings.length} items`,
    group_by: groupBy,
    findings,
  };
  const client = await ensureServer();
  const posted = await client.postCard(input);
  printPosted(posted, "findings", findings.length);
  if (args.flags.json) process.stdout.write(JSON.stringify(posted) + "\n");
  await maybeWait(posted.id, args);
}

/** `triago demo` — a real card in one command, for a first look or a smoke test. */
async function cmdDemo(args: Args): Promise<void> {
  const fixture = path.join(DIST_DIR, "..", "examples", "demo-findings.json");
  if (!fs.existsSync(fixture)) fail(`demo fixture missing at ${fixture}`);
  return cmdFindings({
    ...args,
    _: ["findings", fixture],
    flags: { session: "demo", ...args.flags },
  });
}

async function cmdDoc(args: Args): Promise<void> {
  const markdown = readInput(args._[1]);
  if (!markdown.trim()) fail("document is empty", 2);
  const heading = markdown.match(/^#\s+(.+)$/m);
  const input: CardInput = {
    type: "doc",
    ...cardContext(args),
    ...(str(args.flags.source) ? { source: str(args.flags.source)! } : {}),
    title: str(args.flags.title) ?? heading?.[1]?.trim() ?? path.basename(args._[1] ?? "document"),
    markdown,
    ...(str(args.flags["ack-label"]) ? { ack_label: str(args.flags["ack-label"])! } : {}),
  };
  const client = await ensureServer();
  const posted = await client.postCard(input);
  printPosted(posted, "doc", 1);
  if (args.flags.json) process.stdout.write(JSON.stringify(posted) + "\n");
  await maybeWait(posted.id, args);
}

async function cmdWait(args: Args): Promise<void> {
  const id = args._[1];
  if (!id) fail("usage: triago wait <id> [--timeout secs]", 2);
  const seconds = Number(str(args.flags.timeout) ?? 540) || 540;
  const record = await waitForDecisions(id, seconds);
  if (!record) {
    process.stderr.write(`triago: card ${id} still undecided after ${seconds}s\n`);
    process.exit(3);
  }
  process.stdout.write(JSON.stringify(record, null, 2) + "\n");
}

function renderCard(card: StoredCard, decisions: DecisionsRecord | null): string {
  const lines: string[] = [`${card.id}  ${card.title}`];
  lines.push(
    `  ${card.type} · ${card.source ?? "no source"} · ${card.session ?? "no session"} · ${card.status}`,
  );
  if (card.type === "findings") {
    const decided = new Map((decisions?.items ?? []).map((i) => [i.id, i]));
    for (const f of card.findings) {
      const d = decided.get(f.id);
      const mark = (d ? d.decision.toUpperCase() : "—").padEnd(7);
      const loc = f.file ? ` ${f.file}${f.line ? `:${f.line}` : ""}` : "";
      lines.push(`  ${mark} [${f.severity}] ${f.summary}${loc}`);
      if (d?.comment) lines.push(`          ↳ ${d.comment}`);
    }
  }
  if (decisions) {
    lines.push(
      `  decided ${decisions.decided_at} · ${decisions.tally.fix} fix / ${decisions.tally.skip} skip / ${decisions.tally.discuss} discuss / ${decisions.tally.defer} defer`,
    );
    if (decisions.global_comment) lines.push(`  note: ${decisions.global_comment}`);
  }
  return lines.join("\n");
}

async function cmdShow(args: Args): Promise<void> {
  const id = args._[1];
  if (!id) fail("usage: triago show <id>", 2);
  const client = await ensureServer();
  const { card, decisions } = await client.getCard(id);
  process.stdout.write(
    (args.flags.json ? JSON.stringify({ card, decisions }, null, 2) : renderCard(card, decisions)) +
      "\n",
  );
}

async function cmdLs(args: Args): Promise<void> {
  const client = await ensureServer();
  const { cards } = await client.listCards(str(args.flags.session));
  const filtered = args.flags.open ? cards.filter((c) => c.status === "open") : cards;
  if (args.flags.json) {
    process.stdout.write(JSON.stringify(filtered, null, 2) + "\n");
    return;
  }
  if (!filtered.length) {
    process.stdout.write("no cards\n");
    return;
  }
  for (const c of filtered) {
    const state = c.status === "open" ? `${c.open_items}/${c.total_items} open` : "decided";
    // Cards are stamped in UTC; the person reading the list is not.
    const at = formatClock(c.created_at);
    process.stdout.write(
      `${c.id}  ${at}  ${(c.session ?? "-").padEnd(14)} ${c.type.padEnd(8)} ${state.padEnd(12)} ${c.title}\n`,
    );
  }
}

async function cmdOpen(args: Args): Promise<void> {
  const client = await ensureServer();
  const id = args._[1];
  const url = `${client.baseUrl}${id ? `/c/${id}` : ""}`;
  const opened = openBrowser(`${url}#t=${client.token}`);
  // Opening it by hand is still someone seeing it, so it counts the same as an
  // auto-open — otherwise `status` reports a card as unseen when it is the very
  // one you are looking at.
  if (opened && id) {
    const found = lookupCard(id);
    if (found.ok) markOpened(found.card.id);
  }
  process.stderr.write(`triago: opened ${url}\n`);
}

async function cmdStatus(args: Args): Promise<void> {
  const health = await probe(DEFAULT_PORT);
  const stats = homeStats();
  const payload = {
    running: Boolean(health),
    url: `http://127.0.0.1:${DEFAULT_PORT}`,
    home: TRIAGO_HOME,
    token: readToken() ? "present" : "missing",
    cards: stats,
    ...(health ?? {}),
  };
  if (args.flags.json) {
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    return;
  }
  process.stdout.write(
    health
      ? `triago up · pid ${health.pid} · v${health.version} · ${payload.url} · home ${health.home}\n`
      : `triago down · would listen on ${payload.url} · home ${TRIAGO_HOME}\n`,
  );

  // The two counts worth surfacing are the silent ones. A card nobody opened and
  // a submission nobody collected both look exactly like a working system until
  // someone goes looking, which is the failure this whole line exists to catch.
  if (stats.total) {
    const notes = [
      stats.openUnseen ? `${stats.openUnseen} never opened in a browser` : null,
      stats.undelivered ? `${stats.undelivered} submitted with nothing waiting` : null,
    ].filter(Boolean);
    process.stdout.write(
      `${stats.total} card${stats.total === 1 ? "" : "s"} · ${stats.open} open · ${stats.decided} decided` +
        (notes.length ? `\n  ${notes.join("\n  ")}` : "") +
        "\n",
    );
  }
}

async function cmdRm(args: Args): Promise<void> {
  const ids = args._.slice(1);
  if (!ids.length) fail("usage: triago rm <id…> [--force]", 2);
  const client = await ensureServer();
  const force = Boolean(args.flags.force);
  let removed = 0;
  for (const id of ids) {
    try {
      const result = await client.remove(id, force);
      removed += result.deleted ? 1 : 0;
      process.stdout.write(`removed ${result.card}\n`);
    } catch (err) {
      // Keep going: deleting four ids should not stop dead on the second.
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`triago: ${id}: ${message}\n`);
    }
  }
  if (!removed) process.exitCode = 1;
}

/**
 * Bulk cleanup. Dry by default — it prints what it would remove and takes --yes
 * to actually do it, because there is no undo and the alternative is learning
 * the flags by destroying something.
 */
async function cmdPrune(args: Args): Promise<void> {
  const client = await ensureServer();
  const { cards } = await client.listCards(str(args.flags.session));
  const includeOpen = Boolean(args.flags["include-open"]);
  const olderThan = Number(str(args.flags["older-than"]) ?? "");
  const cutoff =
    Number.isFinite(olderThan) && olderThan > 0 ? Date.now() - olderThan * 86400_000 : null;

  const doomed = cards.filter((c) => {
    if (c.status !== "decided" && !includeOpen) return false;
    if (cutoff !== null && Date.parse(c.created_at) > cutoff) return false;
    return true;
  });

  if (!doomed.length) {
    process.stdout.write("nothing to prune\n");
    return;
  }
  if (!args.flags.yes) {
    process.stdout.write(`would remove ${doomed.length} card(s):\n`);
    for (const c of doomed) {
      process.stdout.write(`  ${c.id}  ${c.status.padEnd(8)} ${c.title}\n`);
    }
    process.stdout.write("\nre-run with --yes to remove them\n");
    return;
  }
  for (const c of doomed) {
    await client.remove(c.id, true);
    process.stdout.write(`removed ${c.id}\n`);
  }
  process.stdout.write(`\npruned ${doomed.length} card(s)\n`);
}

async function cmdStop(): Promise<void> {
  const health = await probe(DEFAULT_PORT);
  if (!health) {
    process.stdout.write("triago already down\n");
    return;
  }
  const token = readToken();
  if (!token) fail("no token found — cannot authenticate shutdown");
  await new TriagoClient(DEFAULT_PORT, token).stop();
  process.stdout.write(`triago stopped (pid ${health.pid})\n`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] ?? "help";
  // Handled before the switch because `--version` never reaches `_` — parseArgs
  // routes anything starting with `--` into flags. The bug report template asks
  // for this first, so it has to work in every spelling somebody will try.
  if (args.flags.version || cmd === "version" || cmd === "-v" || cmd === "-V") {
    process.stdout.write(`${version()}\n`);
    return;
  }
  switch (cmd) {
    case "findings":
      return cmdFindings(args);
    case "doc":
      return cmdDoc(args);
    case "demo":
      return cmdDemo(args);
    case "wait":
      return cmdWait(args);
    case "show":
      return cmdShow(args);
    case "ls":
    case "list":
      return cmdLs(args);
    case "open":
      return cmdOpen(args);
    case "rm":
      return cmdRm(args);
    case "prune":
      return cmdPrune(args);
    case "status":
      return cmdStatus(args);
    case "stop":
      return cmdStop();
    case "token": {
      const token = readToken();
      if (!token) fail("no token yet — post a card first");
      process.stdout.write(token + "\n");
      return;
    }
    case "serve":
      return startServer(Number(str(args.flags.port) ?? DEFAULT_PORT));
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(USAGE + "\n");
      return;
    default:
      process.stderr.write(USAGE + "\n");
      fail(`unknown command: ${cmd}`, 2);
  }
}

main().catch((err: unknown) => {
  fail(err instanceof Error ? err.message : String(err));
});
