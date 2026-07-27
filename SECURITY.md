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

### The one advisory that is left, and why it cannot be fixed here

`npm audit --omit=dev` reports two entries. They are one advisory counted twice —
the package, and the parent that depends on it:

**`@hono/node-server` — path traversal in `serve-static` on Windows via an
encoded backslash** ([GHSA-frvp-7c67-39w9]).

triago's own copy is **not** affected: the direct dependency is on `2.x`, which
is patched. What `npm audit` still sees is a *second, nested* copy:

```
node_modules/@modelcontextprotocol/sdk/node_modules/@hono/node-server
```

The MCP SDK pins `@hono/node-server: ^1.19.9`. Every published `1.x` is inside the
advisory's range (`<2.0.5`) and no patched `1.x` exists, so that caret has nowhere
safe to resolve. Nothing in this repository can move it — only the SDK can, by
widening its range. `npm audit fix` will not clear it either; it loops.

It is not reachable, and that is checkable rather than a promise:

- triago never imports `serveStatic`. It serves the frontend itself, resolving
  the path first and requiring the result to sit under the web directory, so a
  decoded `\` fails that check on Windows too.
- The only SDK files that reference `@hono/node-server` are `streamableHttp.*` —
  its HTTP transport. triago's MCP adapter is **stdio**: one server, one client,
  one process, spawned by the agent. The HTTP transport is never constructed.
- The vulnerable module is therefore never loaded into the process at all:

  ```sh
  node --input-type=module -e '
    await import("@modelcontextprotocol/sdk/server/mcp.js");
    await import("@modelcontextprotocol/sdk/server/stdio.js");
    console.log(process.moduleLoadList.filter(m => m.includes("hono")));
  '
  # => []
  ```

**A deliberate choice not to hide it.** An npm `overrides` entry would force `2.x`
into the SDK and turn this audit green — but `overrides` only apply to the root
project, so it would clear *this repository's* CI while every user who installs
triago still resolved the nested `1.x`. A badge that only the maintainer can
reproduce is worse than an honest number, so the number stays honest.

This is also why the CI gate sits at *critical* rather than *moderate*: a build
that cannot be made green teaches a team to ignore it. The full report prints on
every run. When the SDK widens its range, Dependabot raises it and this section
goes away.

[GHSA-frvp-7c67-39w9]: https://github.com/advisories/GHSA-frvp-7c67-39w9

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
