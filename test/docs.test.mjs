/**
 * The commands the documentation tells a stranger to run.
 *
 * `npx @triago/cli@latest demo` was in the README from 0.1.1 and never worked
 * once: npx resolves a bin by name, and this package ships `triago` and
 * `triago-mcp` while the unscoped package name is `cli`. It fails with
 * `could not determine executable to run`, which names nothing you could fix.
 *
 * That it survived every release since 0.1.1 is the interesting part. RELEASING.md
 * listed the same line as a post-publish check, so the release ritual included
 * running it — and a command that fails at the *registry* step reads like a
 * publish still propagating rather than a sentence that was always wrong.
 *
 * So the resolution rule is encoded here, from npm's own
 * libnpmexec/lib/get-bin-from-manifest.js, and applied to every npx invocation
 * in the docs. A documented command that npm cannot resolve now fails the
 * suite, at the only moment anyone is in a position to notice.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const DOCS = ["README.md", "RELEASING.md", "CONTRIBUTING.md", "TESTING.md"];

/**
 * npm's rule, verbatim in behaviour: a package with one bin (or several aliases
 * of one path) runs that bin whatever it is called; otherwise the bin must be
 * named after the unscoped package; otherwise npx refuses.
 */
function npxCanResolve(manifest) {
  const bin = manifest.bin ?? {};
  if (new Set(Object.values(bin)).size === 1) return Object.keys(bin)[0];
  const unscoped = manifest.name.replace(/^@[^/]+\//, "");
  return bin[unscoped] ? unscoped : null;
}

/** Strip a version range from `@triago/cli@latest` without eating the scope. */
const specName = (spec) => {
  const at = spec.lastIndexOf("@");
  return at > 0 ? spec.slice(0, at) : spec;
};

/**
 * Enough shell to read a documented command: `$(…)` collapses to a placeholder
 * (balanced, because the substitution in RELEASING.md contains its own
 * parentheses and quotes), then whitespace splits and quotes come off.
 */
function shellTokens(command) {
  let flat = "";
  for (let i = 0; i < command.length; i++) {
    if (command[i] === "$" && command[i + 1] === "(") {
      let depth = 0;
      for (; i < command.length; i++) {
        if (command[i] === "(") depth++;
        else if (command[i] === ")" && --depth === 0) break;
      }
      flat += "VERSION";
      continue;
    }
    flat += command[i];
  }
  return flat
    .split(/\s+/)
    .map((t) => t.replace(/["'`]/g, ""))
    .filter(Boolean);
}

/**
 * Every `npx …` command inside a fenced code block. Fences are the copyable
 * surface — prose is allowed to quote the broken form in order to explain it,
 * and the README now does exactly that.
 */
function npxInvocations(file) {
  const out = [];
  let inFence = false;
  fs.readFileSync(path.join(ROOT, file), "utf8")
    .split("\n")
    .forEach((raw, i) => {
      const text = raw.trim();
      if (text.startsWith("```")) {
        inFence = !inFence;
        return;
      }
      if (!inFence || !/(^|[\s(])npx\s/.test(text)) return;
      out.push({ file, line: i + 1, argv: shellTokens(text.slice(text.indexOf("npx ") + 4)) });
    });
  return out;
}

test("every npx command in the docs names a bin npm can actually run", () => {
  const ours = [];
  for (const file of DOCS) {
    for (const call of npxInvocations(file)) {
      // `--package=<spec> <command>` is explicit: npm runs <command> and never
      // has to guess. Everything else leaves npx to infer the bin from a spec.
      const pkgFlag = call.argv.find((a) => a.startsWith("--package"));
      const positional = call.argv.filter((a) => !a.startsWith("-"));
      const where = `${call.file}:${call.line}`;

      if (pkgFlag) {
        const spec = pkgFlag.includes("=")
          ? pkgFlag.slice(pkgFlag.indexOf("=") + 1)
          : call.argv[call.argv.indexOf(pkgFlag) + 1];
        if (!spec?.includes(pkg.name)) continue;
        ours.push(where);
        const command = positional[0];
        assert.ok(
          command && command in pkg.bin,
          `${where} runs "${command}" from this package, which declares no such bin`,
        );
        continue;
      }

      const spec = positional[0];
      if (!spec || specName(spec) !== pkg.name) continue;
      ours.push(where);
      // No --package, so npx has to infer the bin from the spec alone. That is
      // resolvable only under the rule above; today it is not, and if a future
      // bin layout makes it resolvable this passes on its own.
      assert.ok(
        npxCanResolve(pkg),
        `${where} runs \`npx ${spec} …\`, which fails with "could not determine executable to ` +
          `run": npx looks for a bin named "${pkg.name.replace(/^@[^/]+\//, "")}" and this ` +
          `package declares ${Object.keys(pkg.bin).join(" and ")}. ` +
          `Use \`npx -y --package=${spec} triago …\`.`,
      );
    }
  }
  assert.ok(ours.length >= 2, `the docs stopped showing how to run ${pkg.name} at all`);
});
