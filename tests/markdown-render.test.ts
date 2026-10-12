import test from "node:test";
import assert from "node:assert/strict";
import { escapeHtml, renderMarkdown } from "../DoseBuddy_frontend/markdown.js";

// Scenario 8 — rendering: Markdown is rendered to HTML, not shown literally.

test("renders bold **Zinc** as <strong>Zinc</strong>", () => {
  const out = renderMarkdown("**Zinc**");
  assert.ok(out.includes("<strong>Zinc</strong>"), out);
  assert.ok(!out.includes("**Zinc**"), "literal asterisks should not remain");
});

test("renders a heading as a heading element", () => {
  const out = renderMarkdown("# Heading");
  assert.match(out, /<h[1-4][^>]*>Heading<\/h[1-4]>/);
  assert.ok(!out.includes("# Heading"), "literal hash should not remain");
});

test("renders an unordered list with list items", () => {
  const out = renderMarkdown("- a\n- b");
  assert.ok(out.includes("<ul"), out);
  assert.ok(out.includes("<li>a</li>"), out);
  assert.ok(out.includes("<li>b</li>"), out);
});

test("renders an ordered list with list items", () => {
  const out = renderMarkdown("1. first\n2. second");
  assert.ok(out.includes("<ol"), out);
  assert.ok(out.includes("<li>first</li>"), out);
  assert.ok(out.includes("<li>second</li>"), out);
});

test("preserves separation between multiple paragraphs", () => {
  const out = renderMarkdown("First paragraph.\n\nSecond paragraph.");
  const paragraphs = out.match(/<p[^>]*>/g) || [];
  assert.ok(paragraphs.length >= 2, `expected >=2 paragraphs, got: ${out}`);
  assert.ok(out.includes("First paragraph."), out);
  assert.ok(out.includes("Second paragraph."), out);
});

// Scenario 8 — safety: no raw AI/user HTML reaches the DOM.

test("escapes a <script> payload to entities (no live tag)", () => {
  const out = renderMarkdown("<script>alert(1)</script>");
  assert.ok(!out.includes("<script>"), "live <script> tag must not appear: " + out);
  assert.ok(out.includes("&lt;script&gt;"), out);
});

test("escapes an onerror img payload (no live tag)", () => {
  const out = renderMarkdown('<img src=x onerror=alert(1)>');
  assert.ok(!/<img[^>]*onerror/i.test(out), "live <img onerror> must not appear: " + out);
  assert.ok(out.includes("&lt;img"), out);
});

test("escapeHtml converts the four special characters", () => {
  assert.equal(escapeHtml('<a href="x">&</a>'), "&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
});

test("HTML embedded inside Markdown bold is still escaped", () => {
  const out = renderMarkdown("**<b>x</b>**");
  assert.ok(out.includes("<strong>"), "markdown bold should still render: " + out);
  assert.ok(!out.includes("<b>x</b>"), "embedded raw HTML must be escaped: " + out);
  assert.ok(out.includes("&lt;b&gt;x&lt;/b&gt;"), out);
});

// Scenario 9 — robustness: malformed/empty input never throws, always returns a string.

test("empty string returns a safe string without throwing", () => {
  assert.equal(renderMarkdown(""), "");
});

test("null and undefined return a safe string without throwing", () => {
  // @ts-expect-error — exercising defensive null handling
  assert.equal(renderMarkdown(null), "");
  // @ts-expect-error — exercising defensive undefined handling
  assert.equal(renderMarkdown(undefined), "");
  assert.equal(escapeHtml(null as unknown as string), "");
  assert.equal(escapeHtml(undefined as unknown as string), "");
});

test("garbled non-markdown blob returns a string and never throws", () => {
  const blob = "***`#|-\n|||\n### \n**unterminated\n<div><span>&&&";
  const out = renderMarkdown(blob);
  assert.equal(typeof out, "string");
  assert.ok(!out.includes("<div>"), "raw HTML in blob must be escaped: " + out);
});
