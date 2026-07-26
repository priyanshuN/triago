# Design notes

Why triago is shaped the way it is. If you are here to contribute, this is the
context that makes the code make sense; [README.md](README.md) covers usage and
[TESTING.md](TESTING.md) covers how to exercise it.

## The problem, stated precisely

A terminal fails long agent output twice.

**Reading.** No hierarchy, no collapse, no links, and persistence limited to
scrollback. Twelve findings arrive as one wall of text.

**Responding — the worse half.** Per-item judgment has to be typed as prose that
refers back to item numbers: "fix 1, 3 and 7, skip 2, and 4 needs discussion."
The friction of composing that is high enough that the honest outcome is to
accept the batch or skim it. Decision quality degrades at exactly the point where
per-item judgment is the whole value.

triago attacks the second half. The first half comes along for free once the
items are structured.

## The shape that follows

**The agent originates N structured items; the human dispositions each one; the
decisions return as data.** That sentence determines nearly every other choice
here, and it is worth stating what it excludes:

- **Not a session client.** No transcript, no model, no fleet control. Those
  exist and are a different product.
- **Not a diff annotator.** Reviewing a patch line by line is a human
  originating comments on an artifact — the opposite direction of flow. Your code
  host already does it well. triago has nothing to add there, so it does not try.
- **Not a chat.** A card is a bounded set of items with a terminal state. It gets
  submitted once and locks.

## Interaction: triage is an inbox problem

The benchmark for this UI is not a code review tool, it is a keyboard-driven mail
client. The measure is items dispositioned per minute with judgment intact.

- `j`/`k` to move, `f`/`s`/`d`/`t` to decide, `c` to comment, `ctrl ⏎` to submit.
- **After every decision, focus jumps to the next *undecided* item.** This is the
  speed feature. Twelve findings become twelve keystrokes, and the human never
  hunts for what still needs attention.
- Submit is disabled until nothing is undecided, so the returned payload is
  always complete. A `rest → skip` shortcut handles the tail once the calls that
  matter have been made.
- The key legend is a permanent bar, not a help overlay, and it swaps to the
  comment-box keys while you type — the escape route is visible at the moment you
  need it.

### Four decisions, not three

`fix`, `skip`, `discuss`, `defer`. The fourth exists because of a real failure:
the first serious triage put two of ten items in the wrong bucket. "Real, but not
this milestone" had to be faked as `skip` plus a comment, which destroys the only
distinction that matters to the agent — *not a problem* versus *a problem for
later*. `defer` is that distinction, and what filing means is left to the
integrator (an issue, a ticket, a line in a plan file).

The lesson generalises: a decision vocabulary is only worth adding to when the
*follow-through* differs, not when the sentiment does.

## Architecture

### One schema, three interfaces

`src/schema.ts` defines every card and decision exactly once, in zod. From that
single definition:

- the HTTP server validates requests at runtime,
- the frontend imports the inferred types,
- the MCP tools derive their JSON Schemas.

The three interfaces cannot drift, because there is only one definition. This is
the load-bearing argument for TypeScript here — not performance. The workload is
an idle localhost JSON shuttle; a compiled language would not *feel* faster. What
would hurt is an agent and a browser disagreeing about what a card is, and a
single-language repo with one schema module removes that failure mode by
construction. A test asserts that the MCP tool schema really is the generated one,
so the property is enforced rather than hoped for.

### Disk is the truth; the server is a view

Cards and decisions are files under `~/.triago/cards/<id>/`, written atomically
(temp file, then rename). The server holds no authoritative state: it rescans on
start, and a crash mid-wait costs nothing but an in-flight long-poll, which the
CLI re-issues. This is why a blocked `triago wait` survives the server being
killed underneath it.

Cards live in one flat directory with the session as a *field*, not a directory
level, so id lookup needs no index and grouping is a query.

### The server is a lazy daemon

There is no service to install and nothing in your login items. Every entry point
— each CLI command, the MCP shim's startup — probes `127.0.0.1:5599/healthz` and
spawns the server detached if nothing answers. Consequences:

- the first card of the day starts it; nobody starts it by hand;
- a reboot needs no autostart, because the next invocation does it again;
- the **port bind is the lock**. If something is already listening, triago reuses
  it; if that something reports a different protocol version — after an upgrade —
  triago asks it to shut down and starts the new one, so upgrading is
  self-healing.

### Getting the answer back

Four paths, in the order to reach for them:

1. decisions are always written to disk;
2. `triago wait <id>` blocks and prints them;
3. walk away — the agent ends its turn and any later `triago show` picks them up;
4. optionally, a one-line notice typed into the tmux pane that posted the card,
   which wakes an agent that already finished its turn.

**MCP collapses the ladder entirely**: the post tool blocks and the decisions
*are* the tool result. The catch is that clients cap tool calls (around 60s by
default in some), so `wait_seconds` defaults low and a timeout hands back a card
id for `triago_await_decisions`, which is safe to call repeatedly. Degrading to a
poll is designed for, not an error path.

An unanswered card is inert. Nothing hangs, nothing retries in the background,
and no timeout is treated as a failure — `exit 3` means "you were busy."

### Frontend: tokens, not a framework

React plus hand-written CSS with a custom-property token system. No Tailwind, no
component library — deliberately. The UI is one dense keyboard-driven inbox whose
visual language was designed as a token set first; utility classes and a
primitives library would have added dependencies without covering a single
component that ships here. Theme support is token-level: light on `:root`, dark
via `prefers-color-scheme`, and a `data-theme` attribute that overrides both
directions.

The frontend ships prebuilt in the package. Users never run a build.

## Security model

triago holds source excerpts and review data, so it is not open to every process
on the machine:

- binds loopback only;
- a bearer token in `~/.triago/token` (mode 0600), compared in constant time,
  required on every `/api` route. `triago open` hands it to the browser once via
  the URL fragment, which is never transmitted;
- the `Host` header is checked against a localhost allowlist — this is what stops
  a hostile page from resolving its own hostname to 127.0.0.1 and talking to your
  cards;
- a strict CSP (`script-src 'self'`), and rendered markdown is stripped of
  anything executable before it reaches the DOM;
- config values are never passed through a shell — argv arrays only;
- a finding's file path is resolved against configured repo roots and refused if
  it escapes them, absolutely or via `..`, so a click cannot open an arbitrary
  file;
- editor deep-links and tmux injection are off until switched on;
- no telemetry, no network calls, no analytics. There is nothing to opt out of.

## A lesson worth writing down: side effects need a cooldown

The auto-open rule started as "open a tab when no tab is listening." It is wrong,
and wrong in a way that punishes exactly the behaviour you want to encourage: a
tab that is opened but never *activated* may never connect, so "nobody is
listening" stays true and the next card opens another tab, and the next, and the
next. A test run posting a dozen cards produced a dozen tabs.

The fix has two parts, both of which generalise to any tool that touches a user's
desktop:

1. a **cooldown**, persisted across restarts, so a failed signal cannot become a
   loop;
2. an **explicit off switch** (`TRIAGO_NO_BROWSER=1`) that CI and test suites set,
   with a test asserting no tab is ever opened during a test run.

The decision itself is a pure function with unit tests, including one that
asserts twelve cards in a row produce exactly one tab. Side-effect policy is
logic, and logic deserves tests.

## Layout

```
src/schema.ts     every card + decision, defined once (start here)
src/store.ts      atomic file storage, lookup, decision submission
src/server.ts     Hono app: auth, cards, SSE, long-poll, static, open policy
src/client.ts     ensure-server dance + typed HTTP client + blocking wait
src/cli.ts        the command surface
src/mcp.ts        MCP adapter over the same API, schemas from schema.ts
src/side.ts       every outward side effect, one screen, auditable
web/src/          React app: FindingsCard is the one that matters
test/             integration over HTTP, MCP over stdio, unit for policy
```

## Testing philosophy

The suite drives a real server over HTTP on a scratch home directory, because
everything worth breaking lives in the seams: token rejection, `Host` rejection,
long-poll wake-up latency, CLI exit codes, restart-from-disk, the MCP handshake
and its generated schemas. Unit tests are reserved for pure logic where an
integration test would be unsafe to reproduce — the browser-open policy being the
example.

It runs on Node 20, 22 and 24 in CI. The runtime floor is `engines >=20`;
development happens on the current LTS.

## Deliberately not built

- **questions** and **draft** cards — the same card mechanics applied to option
  picks and text approval. Planned.
- **Diff and plan annotation** — see the exclusions above. Not planned.
- **Remote or multi-user anything.** triago is a local tool for one person's
  decisions. Sharing a decision surface across a team is a different product with
  different security requirements.

## Validating the design

The first card triago ever displayed was a review of its own implementation:
ten findings, triaged in the browser, and the seven marked `fix` were then fixed
before anything else happened. Four of them were defects a reader would not have
caught by inspection — including a wait loop that burned its entire budget
retrying a permanent error, and an editor deep-link that would open any absolute
path it was handed.

That is the argument for the whole tool, in one anecdote: the findings existed
either way, but structuring them for per-item judgment is what turned them into
seven fixes instead of a wall of text somebody skimmed.
