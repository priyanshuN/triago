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
git push && git push --tags
gh release create "v$(node -p 'require("./package.json").version')" --generate-notes
```

Creating the release triggers the workflow, which reinstalls from the lockfile,
typechecks, builds, runs the full suite on Node 24, checks the tag matches
package.json, refuses if the package is still private, and only then publishes.

To rehearse without publishing, run the workflow manually from the Actions tab
with `publish` left off — it does everything except the final step.

## After the first publish

Check the package page shows the **Provenance** section with the commit and
workflow, then confirm the install path a stranger will actually use:

```bash
npx @triago/cli@latest demo
```

## After the first release: drop the token

npm supports **trusted publishing** — the workflow authenticates with a
short-lived OIDC credential instead of a stored token, so there is nothing to
rotate and nothing that can leak from repository secrets.

The configuration lives on the package's own page, so it can only be set up once
the package exists — hence the token for release one, then:

1. npmjs.com → the package → **Settings** → **Trusted Publisher** → GitHub Actions.
2. Fill in the organisation/user (`priyanshuN`), the repository (`triago`) and
   the workflow filename (`publish.yml`).
3. Delete the `NPM_TOKEN` repository secret and revoke the token on npmjs.com.
   Do this promptly rather than eventually: as step 3 above explains, that token
   is authorised for every package on the account, not just this one.

The workflow already meets the requirements: it sets `id-token: write`, and Node
24 ships npm 11.13, comfortably past the 11.5.1 minimum. Provenance becomes
automatic under trusted publishing, so the `--provenance` flag is redundant from
then on — harmless to leave, but it can go.

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
