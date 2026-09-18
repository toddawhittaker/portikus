/**
 * The rules that decide what the rich view refuses to render (SPEC.md §13.4,
 * §24.2; ADR 0017). The editor-level behaviour is tested in
 * RichMarkdownEditor.test.tsx; this file pins the two plain functions.
 */
import { expect, test } from "vitest";
import { isSafeImageSrc, isVerbatim, verbatimText } from "./verbatimMarkdown.js";

test("ordinary web addresses and relative paths are safe image sources", () => {
	expect(isSafeImageSrc("https://img.example/badge.svg")).toBe(true);
	expect(isSafeImageSrc("http://img.example/badge.svg")).toBe(true);
	expect(isSafeImageSrc("HTTPS://IMG.EXAMPLE/B.SVG")).toBe(true);
	expect(isSafeImageSrc("./diagram.png")).toBe(true);
	expect(isSafeImageSrc("images/diagram.png")).toBe(true);
	expect(isSafeImageSrc("/images/diagram.png")).toBe(true);
	expect(isSafeImageSrc("//img.example/badge.svg")).toBe(true);
});

test("any other scheme is refused, however it is spelled", () => {
	expect(isSafeImageSrc("javascript:alert(1)")).toBe(false);
	expect(isSafeImageSrc("JavaScript:alert(1)")).toBe(false);
	// Browsers drop whitespace and control characters inside an address, so
	// these are all the same `javascript:` address.
	expect(isSafeImageSrc("java\nscript:alert(1)")).toBe(false);
	expect(isSafeImageSrc("java\tscript:alert(1)")).toBe(false);
	expect(isSafeImageSrc("  javascript:alert(1)")).toBe(false);
	expect(isSafeImageSrc("data:image/svg+xml;base64,AAAA")).toBe(false);
	expect(isSafeImageSrc("vbscript:msgbox(1)")).toBe(false);
	expect(isSafeImageSrc("file:///etc/passwd")).toBe(false);
});

test("raw HTML and unsafe images are shown as source, safe images are not", () => {
	expect(isVerbatim({ type: "html" })).toBe(true);
	expect(isVerbatim({ type: "image", url: "javascript:boom" })).toBe(true);
	expect(isVerbatim({ type: "image", url: "https://img.example/b.svg" })).toBe(false);
	expect(isVerbatim({ type: "paragraph" })).toBe(false);
});

test("the text shown is the construct's own source", () => {
	expect(verbatimText({ type: "html", value: "<!-- note -->" })).toBe("<!-- note -->");
	expect(verbatimText({ type: "image", url: "javascript:boom", alt: "x" })).toBe(
		"![x](javascript:boom)",
	);
	expect(verbatimText({ type: "image", url: "javascript:boom" })).toBe(
		"![](javascript:boom)",
	);
});
