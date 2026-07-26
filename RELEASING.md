# Releasing

Publishing runs in CI, never from a laptop, so every release carries an npm
provenance attestation linking the tarball to the commit and workflow that built
it. The workflow is [.github/workflows/publish.yml](.github/workflows/publish.yml).

## One-time setup

1. **Create an npm automation token.** npmjs.com → Access Tokens → Generate →
   *Automation*. A granular token scoped to this package is better than a classic
   one; it needs publish rights and nothing else.
2. **Add it as a repository secret** named `NPM_TOKEN`
   (Settings → Secrets and variables → Actions → New repository secret).
3. **Make the repository public.** Provenance requires it, and so does anyone
   verifying the attestation.
4. **Remove `"private": true` from package.json.** It is there on purpose: while
   it is set, both `npm publish` and the workflow's guard refuse. Removing it is
   the deliberate act that says the package is ready to exist publicly.

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
npx triago@latest demo
```

## Versioning

Pre-1.0 while the card schema can still change. The schema is the public
contract — an agent's tool call and a stored card both depend on it — so any
breaking change to `src/schema.ts` is a minor bump before 1.0 and a major bump
after, and `PROTOCOL` in that file is bumped whenever the wire format changes
incompatibly, which is what lets a newly installed server take over the port from
an older one.
