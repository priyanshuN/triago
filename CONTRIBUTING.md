# Contributing to triago

Thanks for looking. This file exists so you can tell, before spending an
evening, whether a change is likely to be merged and what it needs to look like.

## Get it running

```bash
git clone https://github.com/priyanshuN/triago && cd triago
npm install
npm run build     # dist/ carries the server and the prebuilt UI
npm test          # ~50 tests, about 30 seconds
```

Node 20 or newer. There is no `postinstall`, no native build step, and nothing to
configure — `npm test` should pass on a fresh clone. If it does not, that is a
bug worth reporting on its own.

Working on the interface:

```bash
npm run dev:web   # Vite on :5600, proxying the API to the real server on :5599
triago demo       # gives you a card to look at
```

The tests set `TRIAGO_NO_BROWSER=1` and a temporary `TRIAGO_HOME`, so running
them never opens tabs or touches your real `~/.triago`.

## Five things about the codebase

Read [DESIGN.md](DESIGN.md) if you want the reasoning. The short version, which
is enough to place most changes:

1. **`src/schema.ts` is the only contract.** The zod shapes there become the
   server's validation, the frontend's types, and the MCP tools' JSON Schemas.
   Change a card's shape there and all three follow. Never hand-write a type or
   a JSON Schema that duplicates one.
2. **Disk is the truth.** Cards and decisions are files under `~/.triago`,
   written temp-then-rename. The server holds no state that matters and rescans
   on start, which is why killing it mid-triage costs nothing.
3. **`src/side.ts` holds every outward side effect** — spawning a browser,
   notifying, opening an editor, tmux. One small function each, argv arrays
   only, never a shell. New side effects go there, not inline, so the whole
   surface stays auditable on one screen.
4. **The frontend is React with no state library, no router and no CSS
   framework.** `web/src/styles.css` is hand-written with design tokens at the
   top. Please stay inside that.
5. **The policy ships with the server.** What an agent should do with a card
   lives in the `instructions` block in `src/mcp.ts`, not in anyone's
   `CLAUDE.md`. If you change what a decision means, change it there and the
   tests that assert it.
6. **The npm package is also the Claude Code plugin.** The same tarball carries
   `.claude-plugin/plugin.json` and `.mcp.json`, so the version lives in three
   files and `npm version` syncs all three — never edit `package.json`'s version
   by hand. If you touch any of those files or the `files` array, test an actual
   install rather than `--plugin-dir`; [TESTING.md](TESTING.md) §7a explains why
   the two are not the same thing, and what it cost to learn that.

## What a good change looks like

- **A test that fails before and passes after**, wherever the change is
  testable. The suite talks to the real thing — HTTP for the API, stdio
  JSON-RPC for MCP — rather than reaching into internals, so tests keep working
  when the implementation moves. Copy the style of the neighbouring test.
- **`npm test && npm run typecheck` clean.** CI runs both on Node 20, 22 and 24.
- **Formatted.** `npm run format` writes it; `npm run format:check` is what CI
  runs. Style is a machine's job here, so nobody has to argue about it in
  review.
- **Comments that say why, not what.** This codebase leans on that heavily. If
  you spent an hour finding out why the obvious version doesn't work, that hour
  belongs in a comment.
- **Docs updated when behaviour changes.** README for anything a user sees,
  [TESTING.md](TESTING.md) for anything only a human can judge, DESIGN.md if you
  changed why something is shaped the way it is.

Commit messages are `type: what changed` — `feat:`, `fix:`, `docs:`, `ci:`,
`test:`, `refactor:`. Write the subject as the effect, not the file touched.

Small PRs get read quickly. A large one is much more likely to be merged if you
open an issue first and we agree on the shape — not as a formality, but because
the alternative is you finishing something that turns out to be off in a way
that costs you the work.

## What will be turned down

Not because the ideas are bad, but because they are outside what this is:

- **Anything that makes a network call at runtime.** Telemetry, update checks,
  crash reporting, remote fonts, a hosted mode, an account. "Nothing leaves your
  machine" is a claim in the README and a check in the tests.
- **An install script.** `postinstall` is the supply-chain hole this project has
  chosen not to have.
- **A new runtime dependency**, unless it replaces more code than it adds.
  There are four, and the number is a feature. Dev dependencies are easier.
- **Sanitising HTML rather than escaping it.** Card markdown is untrusted input.
  Regex sanitisers get defeated; escaping into visible text cannot be. See
  `src/markdown.ts`.
- **Line-by-line diff review.** triago answers a list an agent generated; a
  patch is a human originating comments on an artifact, the opposite direction.
  Your code host already does that well.
- **A fifth decision verb**, for now. `decisions` is a public contract shared by
  the schema, every stored card and the tool shapes, and the case for a new one
  needs more than a single card's evidence. Bring the evidence and it is a real
  conversation.

## Bugs, features and questions

- **A bug** — the issue template asks for your `triago --version`, Node version,
  OS, and whether it came from the CLI or an MCP client. Those four answer most
  reports on their own.
- **A feature** — describe the situation you were in, not the control you want
  added. The best changes in this repo so far came from someone describing a
  triage that went wrong.
- **A question** — [Discussions](https://github.com/priyanshuN/triago/discussions),
  not an issue.
- **A security problem** — do not open an issue.
  [SECURITY.md](SECURITY.md) has the private route.

Issues tagged [`good first issue`](https://github.com/priyanshuN/triago/labels/good%20first%20issue)
are genuinely scoped for someone new: each one names the file and what "done"
means.

## Licence

MIT, and there is no CLA. Opening a pull request means you are fine with your
contribution being released under [the same licence](LICENSE).
