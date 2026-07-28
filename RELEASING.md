# Releasing

Publishing runs in CI, never from a laptop, so every release carries an npm
provenance attestation linking the tarball to the commit and workflow that built
it. The workflow is [.github/workflows/publish.yml](.github/workflows/publish.yml).

## One-time setup — done, and what it cost

All of this is complete. It is written down because each step failed in a way
that was not obvious from the docs, and the next person to publish something
from a repository like this will hit the same three walls.

1. **The package is scoped, and had to be.** npm refuses to create the bare name
   `triago` — `403 Package name too similar to existing package tiag`. That is
   the registry's typosquat filter, and it applies to everyone, so the unscoped
   name is not available to anyone. `@triago/cli` publishes fine, and a scope
   has the better property anyway: only its owner can publish under it.
2. **Classic tokens no longer exist.** npm has retired them; the only kind you
   can create is a granular access token. For CI the decisive setting is the
   **"Bypass two-factor authentication"** checkbox, which is **off by default** —
   without it the workflow dies on `EOTP: This operation requires a one-time
   password`, which CI cannot answer.
3. **The first token cannot be scoped to this package.** A granular token can
   only list packages that already exist, so the token for release one has to
   allow *all packages*. That is the strongest argument for step 4 below: it is a
   broader credential than you want lying around, so retire it immediately.
   Write-enabled granular tokens now expire in 7 days by default and 90 at most,
   so it would need rotating otherwise.
4. **The repository is public and `"private": true` is gone from package.json.**
   Provenance requires a public repository; the private flag was the deliberate
   guard that made both `npm publish` and the workflow refuse until someone
   removed it on purpose.

## Every release

```bash
npm version patch          # or minor / major — writes package.json and tags
git push origin main --follow-tags
gh release create "v$(node -p 'require("./package.json").version')" --generate-notes
```

Creating the release triggers the workflow, which reinstalls from the lockfile,
typechecks, builds, runs the full suite on Node 24, checks the tag matches
package.json, refuses if the package is still private, and only then publishes.

To rehearse without publishing, run the workflow manually from the Actions tab
with `publish` left off — it does everything except the final step.

## Three files carry the version, and `npm version` writes all three

The package is also a Claude Code plugin, so the version appears in
`package.json`, in `.claude-plugin/plugin.json`, and again as the `npx` pin in
`.mcp.json`. They are kept in step by `scripts/sync-plugin-version.mjs`, run from
npm's `version` lifecycle script — which fires after the bump and *before* the
commit, so what it rewrites is staged into the release commit. `npm version` is
therefore the only correct way to bump; editing `package.json` by hand leaves the
other two behind.

Two failures here are silent, which is why both have tests:

- **A stale `plugin.json` version is invisible.** Claude Code uses it as the
  cache key for updates, so a version that does not move means `/plugin update`
  answers *already at the latest version* forever while the new code sits unread
  in the tarball. Nothing errors.
- **A stale `npx` pin runs a different build than the manifest describes**, which
  defeats the point of syncing at all.

The staging is the part that bit: the script rewrote both files but the
lifecycle hook staged only one, so the working tree was correct and the *tagged*
tree was a version behind — a state where every local check passes. CI caught it
and refused to publish. **Verify the tag, not your working tree:**

```bash
for f in package.json .claude-plugin/plugin.json .mcp.json; do
  git show "v$(node -p 'require("./package.json").version'):$f" | grep -m1 -E '"version"|--package='
done
```

Release tags are immutable by repository ruleset, on purpose. A release that
fails to publish is superseded by the next patch version, never by moving a tag —
0.1.0 and 0.3.1 are both tagged and unpublished for this reason, and the
changelog says so.

## After publishing

Check the package page shows the **Provenance** section with the commit and
workflow, then confirm both install paths a stranger will actually use:

```bash
npx @triago/cli@latest demo                    # the CLI
```

```bash
claude plugin marketplace update triago && claude plugin update triago@triago
claude mcp list | grep triago                  # must say ✔ Connected
```

The second is not optional after any change to `.mcp.json`,
`.claude-plugin/plugin.json` or the `files` array. `claude --plugin-dir .`
**cannot** substitute for it: a checkout has `node_modules` beside `dist` and an
installed plugin does not, so a plugin that is broken for every user loads
perfectly from the repository. See [TESTING.md](TESTING.md) §7a.

## There is no npm credential in this repository

Releases authenticate by **trusted publishing**: npm trusts this workflow, by
filename, in this repository, and GitHub mints a short-lived OIDC token for each
run. Nothing is stored, so nothing expires, rotates, or leaks. `NPM_TOKEN` was
deleted after 0.1.1 and the token revoked.

That is also why `publish.yml` sets no `NODE_AUTH_TOKEN`: a stored token takes
precedence over OIDC, so its *absence* is what keeps releases on the trusted
path. If you ever add one back, you have quietly turned this off.

Two settings hold it in place, both on the package page:

- **Trusted Publisher** → GitHub Actions → `priyanshuN` / `triago` /
  `publish.yml`, permission `npm publish`. **Environment name must be empty** —
  the workflow declares no GitHub Actions environment, and a value here would not
  match the claim the workflow presents, rejecting every publish.
- **Publishing access** → *Require two-factor authentication and disallow
  tokens*. Trusted publishers keep working under it, so this costs nothing and
  means a stolen token cannot publish this package at all. Interactive publishing
  with 2FA still works if you ever need to break glass.

The requirements are already met: `id-token: write`, Node 24, npm 11.13 (past the
11.5.1 minimum). `--access public` must stay — scoped packages default to
restricted, which a free account cannot publish.

**Rehearsals cannot prove any of this.** Running the workflow with `publish` off
skips the publish step entirely, so it never touches authentication. The first
real release after a change here is the proof; if it fails on auth, re-add a
scoped token as a stopgap rather than debugging under pressure.

## Recording screenshots and demos

Anything you record shows more than the card: the sidebar lists every other card
in that home directory, the footer names the session, and each finding shows a
file path. Record from a scratch home so none of that can be yours:

```bash
TRIAGO_HOME=/tmp/triago-demo triago demo --wait
```

That mints a separate token, starts with an empty sidebar, and shows only the
demo card. Delete the directory afterwards. Check the frame for the terminal
prompt too — a shell prompt showing a real path or hostname is the usual leak.

The bundled fixture (`examples/demo-findings.json`) is deliberately generic —
sessions, queues, pagination, tokens — so it says nothing about what anyone
works on. Keep it that way: it is the first thing every new user sees, and it is
in every frame of any demo.

## Versioning

Pre-1.0 while the card schema can still change. The schema is the public
contract — an agent's tool call and a stored card both depend on it — so any
breaking change to `src/schema.ts` is a minor bump before 1.0 and a major bump
after, and `PROTOCOL` in that file is bumped whenever the wire format changes
incompatibly, which is what lets a newly installed server take over the port from
an older one.
