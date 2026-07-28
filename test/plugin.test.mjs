/**
 * The Claude Code plugin manifests.
 *
 * These are three small JSON files that nobody looks at again once they work,
 * describing the same artifact as package.json. Every failure mode here is
 * silent: a stale version means Claude Code's update check says "already at the
 * latest version" and users never receive the release; a manifest missing from
 * the `files` array means the published tarball simply isn't a plugin, and the
 * install fails for someone else on a machine you cannot see.
 *
 * So each one is asserted against package.json, which is the source of truth
 * because `npm version` writes it.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p) => JSON.parse(fs.readFileSync(path.join(ROOT, ...p), "utf8"));

const pkg = read("package.json");
const plugin = read(".claude-plugin", "plugin.json");
const marketplace = read(".claude-plugin", "marketplace.json");
const mcp = read(".mcp.json");

test("the plugin version matches the package version", () => {
  assert.equal(
    plugin.version,
    pkg.version,
    "run `node scripts/sync-plugin-version.mjs` — Claude Code uses this as its update cache key, " +
      "so a stale value means installed users are told they are up to date when they are not",
  );
});

test("the marketplace points at this package", () => {
  const entry = marketplace.plugins.find((p) => p.name === plugin.name);
  assert.ok(entry, `marketplace.json lists no plugin named "${plugin.name}"`);
  assert.equal(entry.source.source, "npm");
  assert.equal(
    entry.source.package,
    pkg.name,
    "the marketplace would install a different package than this repository publishes",
  );
});

/**
 * npm ships only what `files` lists. Both manifests are dotfiles, which is
 * exactly the kind of path that gets dropped without anyone noticing until an
 * install fails somewhere else.
 */
test("both manifests are in the files array, so they actually ship", () => {
  for (const f of [".claude-plugin/plugin.json", ".mcp.json"]) {
    assert.ok(pkg.files.includes(f), `package.json "files" is missing ${f}`);
  }
});

/**
 * The plugin name is the skill namespace and the install identifier, and the
 * package name cannot be reused for it: "@triago/cli" carries a scope and a
 * slash, while a plugin name must be kebab-case with neither.
 */
test("the plugin name is a legal plugin name", () => {
  assert.match(plugin.name, /^[a-z0-9]+(-[a-z0-9]+)*$/, "must be kebab-case, no scope or slash");
});

/**
 * The plugin starts its server through npx rather than by running
 * ${CLAUDE_PLUGIN_ROOT}/dist/mcp.js directly, and that is not a style choice.
 *
 * Claude Code installs an npm-sourced plugin by extracting the tarball — no
 * `npm install` in the cache directory, so there is no node_modules beside the
 * extracted dist. Running the entry point in place dies immediately on
 * `ERR_MODULE_NOT_FOUND` for @modelcontextprotocol/sdk, which surfaces only as
 * "Connection closed" in `claude mcp list`. It passes under `--plugin-dir`
 * against a checkout, because a checkout has node_modules — so the working
 * configuration and the broken one look identical in local testing.
 *
 * npx fetches the package with its dependencies and runs the declared bin.
 */
test("the MCP server is launched in a way that resolves its dependencies", () => {
  const server = mcp.mcpServers[plugin.name];
  assert.ok(server, `.mcp.json declares no server named "${plugin.name}"`);
  assert.equal(server.command, "npx");

  assert.ok(
    !server.args.some((a) => a.includes("${CLAUDE_PLUGIN_ROOT}")),
    "a path inside the plugin cache has no node_modules next to it and cannot start",
  );
  assert.ok(
    server.args.includes("triago-mcp") && "triago-mcp" in pkg.bin,
    "the bin npx runs must be one this package actually declares",
  );
});

/**
 * The pin is the third copy of the version. Unpinned, npx would fetch whatever
 * is newest when the server spawns — a different build than the manifest
 * describes, which is precisely what syncing the manifest exists to prevent.
 */
test("the npx version pin matches the package version", () => {
  const pin = mcp.mcpServers[plugin.name].args.find((a) => a.startsWith("--package="));
  assert.ok(pin, ".mcp.json must pin the package version, not float to latest");
  assert.equal(
    pin,
    `--package=${pkg.name}@${pkg.version}`,
    "run `node scripts/sync-plugin-version.mjs`",
  );
});
