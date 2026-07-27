/**
 * The two primitives a markdown card needs to reach the DOM safely.
 *
 * A card's markdown is written by an agent and can quote anything it read, so
 * it is untrusted input that gets rendered as HTML. The previous approach was a
 * blacklist of regexes stripping <script>, event handlers and `javascript:`
 * URLs out of marked's output. That is the pattern CodeQL flags as
 * js/incomplete-multi-character-sanitization, and it was defeatable in at least
 * four ways: the `javascript:` rule required the URL to be quoted, so
 * `href=javascript:alert(1)` passed untouched; an HTML entity
 * (`java&#115;cript:`) or an embedded tab both survive the regex and are then
 * normalised back by the browser; and `<base>` was not on the blacklist at all.
 *
 * Sanitising HTML means enumerating every way a parser can be surprised, which
 * is not a list anyone finishes. So this does not sanitise HTML — it refuses
 * it. Raw HTML in a card is escaped and rendered as visible text, and the only
 * URLs that survive are ones whose scheme is on a short allowlist. There is no
 * markup an agent can emit that becomes live markup in the page.
 *
 * These are kept dependency-free and here rather than in web/ so the node test
 * suite can exercise them directly; the marked wiring lives in DocCard.
 */

/** Render text as text: the four characters that could otherwise open a tag. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Schemes a card is allowed to link to. `http(s)` and `mailto` cover every
 * legitimate use — a repo URL, a PR, an advisory, an address. Everything else,
 * including `javascript:`, `data:` and `vbscript:`, is refused. Relative paths
 * and `#anchor` links carry no scheme and are fine.
 */
const ALLOWED_SCHEME = /^(?:https?|mailto):$/;

/**
 * Decide a URL the way the browser will, then judge it.
 *
 * Both steps matter. A browser decodes HTML entities and drops tab, newline and
 * other control characters *before* it works out the scheme, so
 * `java&#115;cript:` and a tab-split `javascript:` are both `javascript:` by
 * the time anything executes. Judging the raw string would miss both.
 */
export function isSafeHref(href: string): boolean {
  const decoded = href
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex) => codePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_, dec) => codePoint(Number(dec)))
    .replace(/&colon;/gi, ":")
    // Whitespace and control characters are ignored inside a scheme, so they
    // come out before the scheme is read. \s alone does not cover C0/DEL.
    .replace(/[\s\u0000-\u001f\u007f]/g, "");

  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(decoded)?.[1];
  // No scheme at all: a relative path or an anchor. Nothing to execute.
  if (!scheme) return true;
  return ALLOWED_SCHEME.test(`${scheme.toLowerCase()}:`);
}

function codePoint(value: number): string {
  return Number.isFinite(value) && value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : "";
}
