/**
 * Card markdown is written by an agent and can quote anything it read, so it is
 * untrusted input rendered as HTML.
 *
 * Every "refuses" case below is a payload that got past the regex sanitizer this
 * replaced — they are regression tests for real bypasses, not hypotheticals. The
 * "allows" cases exist because a check that refuses everything is easy and
 * useless; a doc card has to be able to link to a PR.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const { escapeHtml, isSafeHref } = await import(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "markdown.js")
);

test("refuses javascript: however it is spelled", () => {
  const payloads = [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "  javascript:alert(1)", // leading whitespace is ignored by the parser
    "java\tscript:alert(1)", // an embedded tab likewise
    "java\nscript:alert(1)",
    "java&#115;cript:alert(1)", // decimal entity, decoded before the scheme is read
    "java&#x73;cript:alert(1)", // hex entity
    "javascript&colon;alert(1)", // named colon entity
    "javascript:alert(1)", // a C0 control the parser drops
  ];
  for (const href of payloads) {
    assert.equal(isSafeHref(href), false, `should have refused: ${JSON.stringify(href)}`);
  }
});

test("refuses the other schemes that can execute or impersonate", () => {
  for (const href of [
    "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "blob:https://example.com/x",
  ]) {
    assert.equal(isSafeHref(href), false, `should have refused: ${href}`);
  }
});

test("allows the URLs a card legitimately needs", () => {
  for (const href of [
    "https://github.com/priyanshuN/triago/pull/1",
    "http://127.0.0.1:5599/c/abc",
    "mailto:someone@example.com",
    "#a-heading-anchor",
    "./docs/DESIGN.md",
    "../sibling/file.ts",
    "docs/x.md?q=1&r=2",
  ]) {
    assert.equal(isSafeHref(href), true, `should have allowed: ${href}`);
  }
});

test("a scheme that merely starts with an allowed one is still refused", () => {
  // Guards against a prefix check replacing the exact-match one.
  assert.equal(isSafeHref("javascript:https://example.com"), false);
  assert.equal(isSafeHref("httpsx:alert(1)"), false);
  assert.equal(isSafeHref("https-evil:alert(1)"), false);
});

test("escapeHtml closes every character that could open a tag", () => {
  assert.equal(escapeHtml('<script>alert("x")</script>'), "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
  assert.equal(escapeHtml("a & b"), "a &amp; b");
  // The ampersand must be escaped first, or the others get double-escaped.
  assert.equal(escapeHtml("&lt;"), "&amp;lt;");
});

test("escapeHtml leaves ordinary prose alone", () => {
  const plain = "A normal sentence, with punctuation — and an em dash.";
  assert.equal(escapeHtml(plain), plain);
});
