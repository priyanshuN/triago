# Security

triago runs a local HTTP server that holds review data and source excerpts, and
can be configured to open your editor and type into a tmux pane. That is a real
surface, so this document says what it is, what protects it, and what no badge on
this page can promise.

## Reporting a vulnerability

Use GitHub's private reporting — **Security → Report a vulnerability** on this
repository. It reaches the maintainer without disclosing the issue publicly first.
Please include what you did, what happened, and what you expected. There is no
bounty; there will be a fix and credit if you want it.

If it is a straightforward bug with no security consequence, a normal issue is
easier for everyone.

## What triago trusts, and what it doesn't

**Trusted:** the person at the keyboard, the agent they chose to run, and the
files in their own `~/.triago`.

**Not trusted:** the content of a card. A card arrives as JSON from an agent that
may have read a hostile pull request, a dependency's README, or a web page. So
finding text is data, never instruction: markdown is stripped of anything
executable before it reaches the DOM, and a file path in a finding is resolved
against `repo_roots` and refused if it escapes them. A card cannot make triago
open `~/.ssh/id_rsa` by asking nicely.

**Also not trusted:** every other process and page on the machine. Localhost is
not a security boundary by itself — any page in your browser can issue requests
to `127.0.0.1`, and any local process can connect to an open port.

## What protects it

| Surface | Control |
|---|---|
| Network exposure | binds `127.0.0.1` only; no runtime network calls at all, including fonts |
| API access | bearer token in `~/.triago/token`, mode 0600, compared with `timingSafeEqual` |
| DNS rebinding | `Host` header checked against a localhost allowlist |
| Token handover | passed once in the URL fragment, which browsers never send to a server |
| Injected script | CSP `script-src 'self'`; rendered markdown sanitised |
| Static file serving | path resolved then contained under the web directory, with a test for the traversal payloads |
| Editor deep-link | argv array, never a shell string; off until enabled; path must resolve inside `repo_roots` |
| tmux injection | off until enabled |
| Install-time code execution | **no `preinstall` or `postinstall` script** — triago does not use the mechanism |
| Telemetry | none. No analytics, no phone-home, nothing to opt out of |

The controls in that table have regression tests: auth rejection, `Host`
rejection, path traversal on the static route, and `repo_roots` containment on the
editor link. They are asserted, not asserted-to.

## Supply chain

- **Provenance.** Releases are published from CI with `--provenance`, so npm
  carries a verifiable link from the published tarball back to the exact public
  commit and workflow that built it. Check it on the package page, or with
  `npm audit signatures`.
- **Four direct runtime dependencies** (`hono`, `@hono/node-server`,
  `@modelcontextprotocol/sdk`, `zod`), 94 transitive. Small enough to read.
- **Dependabot** watches npm and GitHub Actions. Actions matter as much as
  dependencies here, because the publish workflow holds the npm credential.
- **`npm audit --omit=dev`** runs in CI on every push and prints the full report.
  It fails the build on a *critical* advisory rather than a high one — see below.

### Known advisories that do not apply

`npm audit` on the shipped tree currently reports two. Both are real, neither is
reachable in triago, and you deserve the reasoning rather than a reassurance:

- **`@hono/node-server` — path traversal in `serve-static` on Windows via an
  encoded backslash.** triago never imports `serveStatic`. It serves the frontend
  itself, resolving the path first and then requiring the result to sit under the
  web directory, so a decoded `\` fails that check on Windows too. The fix is a
  semver-major bump and will be taken when the rest of the tree is ready for it.
- **`@modelcontextprotocol/sdk` — cross-client data leak via a shared
  server/transport instance.** That is a multi-client HTTP/SSE pattern. triago's
  MCP adapter is stdio: one server instance, one client, one process, spawned by
  the agent itself. There is also, at the time of writing, no fixed version to
  move to — the advisory covers the current release.

This is why the CI gate sits at critical. A build that cannot be made green
teaches a team to ignore it, and an advisory with no published fix would do
exactly that. When a fix ships, Dependabot raises it and the gate moves up.

## What the badges do and do not say

**No badge on this page certifies that triago is free of security risk.** Nothing
does, for any package. What each one actually means:

- **OpenSSF Scorecard** grades *practices* — branch protection, pinned
  dependencies, whether CI runs tests, whether a workflow could be made to run
  untrusted code. A high score means mistakes are likelier to be caught. A
  project can score well and still ship a vulnerability, or be malicious.
- **CodeQL** finds *known patterns* of bug. A clean result means those patterns
  were not found, not that none exist.
- **`npm audit` clean** means no *published advisory* matches the dependency
  versions today. It says nothing about tomorrow, or about triago's own code.
- **npm provenance** is the strongest of them, and it is narrow: it proves the
  tarball came from a specific public commit built by a specific workflow. It
  proves *origin*, not safety — but it means reading the code is actually
  meaningful, because you can be sure the code you read is the code you ran.

If you want assurance beyond that, the honest answer is the size of the thing:
four runtime dependencies, no install scripts, no network calls, one localhost
port, and a few thousand lines you can read in an afternoon.
