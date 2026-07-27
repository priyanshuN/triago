<!--
Thanks for the PR. Keep this short — a couple of sentences per heading is
plenty. If it fixes an open issue, put "Fixes #123" somewhere in the body.
-->

## What changes

## Why

<!-- The situation that made this worth doing. If it fixes a bug, what the user saw. -->

## How you verified it

<!--
Beyond CI. A new failing-then-passing test is the strongest answer. For things
a test cannot judge — how triage feels, the editor deep-link, tmux, MCP from a
real client — say which walkthrough in TESTING.md you ran, and on what.
-->

---

- [ ] `npm test` and `npm run typecheck` pass
- [ ] `npm run format:check` passes (`npm run format` fixes it)
- [ ] Docs updated if behaviour changed — README for anything a user sees,
      TESTING.md for anything only a human can judge, DESIGN.md if you changed
      *why* something is shaped the way it is
- [ ] No new runtime dependency, no runtime network call, no install script
      (see [CONTRIBUTING.md](../blob/main/CONTRIBUTING.md#what-will-be-turned-down))
