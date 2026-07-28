/**
 * Copies the version from package.json into .claude-plugin/plugin.json.
 *
 * Two version numbers describing one artifact is a drift bug waiting to
 * happen, and this one fails quietly in a way nobody would notice: Claude Code
 * uses the plugin's version as its update cache key, so a stale number means
 * `/plugin update` reports "already at the latest version" and users simply
 * never receive the release. Nothing errors.
 *
 * package.json is the source of truth because `npm version` writes it. This
 * runs from npm's `version` lifecycle script, which fires after the bump and
 * before the commit is made — files staged here land in the release commit, so
 * the two numbers cannot be published apart. api.test.mjs asserts they match,
 * for the case where someone edits package.json by hand instead.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { name, version } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

/**
 * Both files are rewritten by pattern rather than by parsing and re-serialising,
 * so they keep their key order and formatting and the diff stays one line each.
 */
const edits = [
  {
    file: path.join(root, ".claude-plugin", "plugin.json"),
    find: /("version":\s*)"[^"]*"/,
    replace: `$1"${version}"`,
    missing: "plugin.json has no version field to sync",
  },
  {
    // The version pin in the plugin's npx invocation. Unpinned, the plugin
    // would fetch whatever is newest at spawn time, which is a different build
    // than the manifest describes and undoes the point of syncing at all.
    file: path.join(root, ".mcp.json"),
    find: new RegExp(`--package=${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}@[^"]*`),
    replace: `--package=${name}@${version}`,
    missing: `.mcp.json has no --package=${name}@… pin to sync`,
  },
];

let changed = 0;
for (const { file, find, replace, missing } of edits) {
  const before = fs.readFileSync(file, "utf8");
  if (!find.test(before)) {
    console.error(`${missing} — add one`);
    process.exit(1);
  }
  const after = before.replace(find, replace);
  if (after === before) continue;
  fs.writeFileSync(file, after);
  console.log(`${path.basename(file)} → ${version}`);
  changed++;
}

if (!changed) console.log(`plugin manifests already at ${version}`);
