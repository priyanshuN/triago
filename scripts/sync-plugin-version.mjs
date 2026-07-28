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
const manifestPath = path.join(root, ".claude-plugin", "plugin.json");

const { version } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

if (manifest.version === version) {
  console.log(`plugin.json already at ${version}`);
  process.exit(0);
}

// Rewritten by hand rather than with JSON.stringify(manifest) so the file keeps
// its key order and formatting, and the diff is one line rather than the whole
// manifest reshuffled.
const updated = fs
  .readFileSync(manifestPath, "utf8")
  .replace(/("version":\s*)"[^"]*"/, `$1"${version}"`);

if (!/"version":\s*"/.test(updated)) {
  console.error("plugin.json has no version field to sync — add one");
  process.exit(1);
}

fs.writeFileSync(manifestPath, updated);
console.log(`plugin.json ${manifest.version} → ${version}`);
