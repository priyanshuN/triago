/**
 * `import()` of a bare absolute path works on POSIX and throws on Windows, where
 * `D:\\a\\triago\\dist\\x.js` parses as a URL with the scheme `d:` —
 * ERR_UNSUPPORTED_ESM_URL_SCHEME. Five test files did this and every one of them
 * failed to load the first time the suite ran on a Windows runner. Going through
 * pathToFileURL is the portable form.
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");

/** Import a built module by file name, e.g. dist("server.js"). */
export function dist(file) {
  return import(pathToFileURL(path.join(DIST, file)).href);
}
