/**
 * Loaded with `--import` by the `test` script, and therefore by every process
 * `node --test` spawns — it passes execArgv down to the per-file children.
 *
 * This used to be an inline `TRIAGO_NO_BROWSER=1` in front of the command, which
 * is POSIX shell syntax: on Windows npm runs scripts through cmd.exe, where that
 * form is a syntax error rather than an assignment, so the suite could not start
 * at all. Since the bug this repo is fixing is specifically a Windows one, the
 * test command had to become runnable there first.
 *
 * `??=` rather than `=` so a deliberate override from the environment still wins.
 */
process.env.TRIAGO_NO_BROWSER ??= "1";
