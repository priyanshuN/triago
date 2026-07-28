# Changelog

Notable changes per release. Every entry links to the
[GitHub release](https://github.com/priyanshuN/triago/releases), which carries
the full reasoning — what went wrong, and why the fix is shaped the way it is.

This project follows [semantic versioning](https://semver.org/spec/v2.0.0.html).
Before 1.0 the card format, the HTTP API and the MCP tool shapes may still
change; when they do, it will be a minor bump and it will be said here.

## [0.3.4] — 2026-07-28

**Fixed**

- The instructions told the agent to call a tool it may not have been holding.
  A client carrying a large toolset can defer an MCP server's tools to a
  name-only listing, callable only after their schemas are loaded — so at the
  moment an agent finishes a review and decides what to do with the list,
  printing costs nothing and posting costs a lookup first. The policy read
  `call triago_post_findings instead of printing them`, which presumes the tool
  is already to hand. Faced with a rule naming an unloaded tool, agents printed.

  The instructions now say the tools may need loading and to do it. The note
  sits inside `When to use it` rather than at the end, because the tail of a
  long instructions string is what a host truncates first — and the trigger is
  no use if it is the part that survives while the means of acting on it is not.

  Measured rather than assumed. The same prompt, in the same workspace, before
  and after: without the line, seven findings printed to the terminal and no
  card; with it, the agent loaded the tool unprompted and posted eleven. The
  earlier theory — that the trigger was losing because the instructions were
  truncated — did not survive checking, since the threshold sat above the cut in
  both sessions. It was never a delivery problem.

## [0.3.3] — 2026-07-28

**Fixed**

- `triago_await_decisions` with `wait_seconds: 0` never asked the server, so it
  answered `pending` for every card — including cards decided hours earlier.
  `waitForDecisions` guarded its polling loop with `while (Date.now() <
  deadline)`, and a deadline of `now + 0` is already in the past, so the body
  never ran.

  This is the asynchronous pickup path, and the shipped instructions name
  `wait_seconds: 0` as the check to run at the top of every turn while a card is
  outstanding — so an agent following the policy exactly could only ever collect
  decisions it had synchronously blocked for. A card triaged after the posting
  call had returned was, in practice, never read. Zero now performs one real
  non-blocking read.

  The suite missed it because every other test waits with a real duration: the
  one value the policy recommends was the one value never exercised.

**Changed**

- The decision policy now says where a `fix` goes when the code is not yours. It
  previously read "act on it now, in this session", which is impossible on a
  review of someone else's pull request — there is no branch the agent may edit.
  Acting on a finding there means raising it as a review comment, and the
  instructions say so now rather than leaving the agent to promise an edit it
  has no business making. Found by using it: the first card an agent posted of
  its own accord was a review where the human was the reviewer, not the author.

## [0.3.2] — 2026-07-28

**Fixed**

- The release script rewrote the version pin in `.mcp.json` but staged only
  `.claude-plugin/plugin.json`, so the pin never entered the release commit. The
  working tree looked correct while the tagged tree was a version behind. CI
  caught it and refused to publish; the fix stages both files.

## [0.3.1] — 2026-07-28

Tagged but never published — the release above describes why. Nothing exists on
the registry under this version.

**Fixed**

- The plugin's MCP server failed to start once installed. Claude Code installs
  an npm-sourced plugin by extracting the tarball, without running `npm install`
  in the cache directory — so running `${CLAUDE_PLUGIN_ROOT}/dist/mcp.js` in
  place died on `ERR_MODULE_NOT_FOUND`, surfacing only as `Connection closed`.
  It now launches through `npx`, which fetches the dependencies and runs the
  declared bin. The version is pinned so the plugin cannot silently run a
  different build than its manifest describes.

  This passed local testing under `--plugin-dir` because a checkout has
  `node_modules` beside `dist`, which an installed plugin does not — the working
  and broken configurations were indistinguishable until it was installed for
  real.

## [0.3.0] — 2026-07-28

**Added**

- triago installs as a Claude Code plugin: `/plugin marketplace add
  priyanshuN/triago` then `/plugin install triago@triago`. Claude Code fetches
  the package and resolves the server path itself, so the install involves no
  global install, no PATH and no version manager — which removes a real class of
  failure, where registering `triago-mcp` by bare name works in your shell and
  fails with a bare `ENOENT` in an app launched from a dock.
- The plugin is the npm package rather than a second artifact: the same tarball
  now carries `.claude-plugin/plugin.json` and `.mcp.json`, so both channels
  publish together and share one version number. `npm version` syncs the
  manifest, and a test fails if the two ever disagree — a stale plugin version
  is invisible, because Claude Code uses it as an update cache key and would
  tell installed users they are current when they are not.

## [0.2.1] — 2026-07-27

**Added**

- `triago --version`, which had been missing. The version was only reachable
  through `triago status`, and that needs the server up — so it was unavailable
  in exactly the situation you want it, reporting a bug where the server will
  not start. `-v` and a bare `version` work too. The new issue template asks for
  it as its first required field, so shipping the template without the flag left
  a public form asking for something the package could not produce.
- The changelog now ships in the npm package rather than living only on GitHub.

**Changed**

- Prettier is enforced in CI, so style is settled by a formatter instead of in
  review. Rewrapping only — no behaviour changed.
- The repository grew a contribution guide, a code of conduct, issue and pull
  request templates, and an OpenSSF Best Practices passing badge. None of that
  affects the installed package beyond the README it ships with.

## [0.2.0] — 2026-07-27

**Added**

- The desktop notification offers an **Open card** action that launches the card
  with its token, so getting from "a card arrived" to reading it is a click
  rather than reading an id off a toast and typing it back. Guarded: `--action`
  and `--wait` arrived in libnotify 0.8, and 0.7.x rejects them and prints
  nothing at all, so support is probed once and cached. Where it is missing the
  plain notification still carries the card id. macOS stays plain.
- `triago status` counts the two failures that look identical to a healthy
  system from the outside — cards never opened in a browser, and cards submitted
  with nothing waiting to receive them.

No schema, card-format or API change.

## [0.1.6] — 2026-07-27

**Changed**

- The MCP instructions make picking a card back up the normal path. A real
  triage outlasts the tool call that posted the card, so the timeout is the
  usual ending, not a failure: the agent is now told to end its turn and check
  on the next one with `wait_seconds 0`, which answers immediately and costs
  nothing. Polling in a loop is ruled out explicitly, and `triago_list_cards`
  covers a lost id or a different session entirely.

Instructions only.

## [0.1.5] — 2026-07-27

**Changed**

- `discuss` now means "the human has something to say about this before you
  act", not "stop and bring it back". The first real review through the tool came
  back 9 `discuss` / 1 `fix` where every comment was an *answer*, so an agent
  following the old wording would have gone back and asked nine questions that
  had just been answered in front of it. The instructions now state that the
  comment is the substance and the verb only says how to file it, and that most
  comments are corrections to be accepted rather than defended.

Instructions and wording only.

## [0.1.4] — 2026-07-27

**Fixed**

- The page no longer claims a handoff that did not happen. Submitting said
  "decisions returned to agent" and the rail said "agent waiting" even when
  nothing was listening — which is the normal case, not an edge case. The server
  now reports `waiting` per card and `delivered` on submit, and a card submitted
  into silence says so and offers the command that resumes it.
- The browser-open decision is logged with its reason. It used to be returned
  only to whoever posted the card, which for an MCP call is the agent — so a
  human who got no tab also got no clue why.
- A finding's summary no longer hides behind a hover on the row you opened to
  read it, and card titles wrap instead of ellipsing to a stub.

`waiting` and `delivered` are additive; no breaking change.

## [0.1.3] — 2026-07-27

**Fixed**

- A card created between midnight and 1am listed its time as hour **24** —
  `00:07` rendered as `24:07` — in both the CLI listing and the browser rail.
  `hour12: false` resolves to the h24 cycle in several locales; the fix pins
  `hourCycle: "h23"` and the locale still comes from the reader. It survived two
  releases because every check happened at some other time of day.

## [0.1.2] — 2026-07-27

**Changed**

- Publishing authenticates with a short-lived OIDC credential minted per run
  instead of a stored npm token. Nothing is stored, so nothing expires or leaks.
  The tarball is byte-identical to 0.1.1; this release exists to prove the
  credential-free path, which a rehearsal run cannot do.

## [0.1.1] — 2026-07-27

First release published to npm, as `@triago/cli`. Findings and doc cards, the
CLI with its full return ladder, the MCP adapter with four tools, token auth,
and a suite that runs on Node 20, 22 and 24.

The package is scoped because npm's typosquat filter refuses to create the bare
name `triago` for anybody — it is too close to an existing package called
`tiag`. The commands themselves are unscoped.

## [0.1.0] — 2026-07-27

Tagged but never published; npm rejected the unscoped name. No 0.1.0 exists on
the registry.

[0.3.2]: https://github.com/priyanshuN/triago/releases/tag/v0.3.2
[0.3.1]: https://github.com/priyanshuN/triago/releases/tag/v0.3.1
[0.3.0]: https://github.com/priyanshuN/triago/releases/tag/v0.3.0
[0.2.1]: https://github.com/priyanshuN/triago/releases/tag/v0.2.1
[0.2.0]: https://github.com/priyanshuN/triago/releases/tag/v0.2.0
[0.1.6]: https://github.com/priyanshuN/triago/releases/tag/v0.1.6
[0.1.5]: https://github.com/priyanshuN/triago/releases/tag/v0.1.5
[0.1.4]: https://github.com/priyanshuN/triago/releases/tag/v0.1.4
[0.1.3]: https://github.com/priyanshuN/triago/releases/tag/v0.1.3
[0.1.2]: https://github.com/priyanshuN/triago/releases/tag/v0.1.2
[0.1.1]: https://github.com/priyanshuN/triago/releases/tag/v0.1.1
[0.1.0]: https://github.com/priyanshuN/triago/releases/tag/v0.1.0
