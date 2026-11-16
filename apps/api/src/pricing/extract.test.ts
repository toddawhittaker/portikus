import { describe, expect, test } from "vitest";
import { PAGE_TEXT_MAX_CHARS, pageText } from "./extract.js";

describe("pageText", () => {
	test("drops scripts, styles, comments and tags, and collapses whitespace", () => {
		const html = `<html><head><style>.a{color:red}</style><script>alert("x")</script></head>
			<body><!-- hidden --><h1>Prices</h1>\n\n<p>Input&nbsp;$2.00 &amp; more &#36;1 &#x24;3</p></body></html>`;
		expect(pageText(html)).toBe("Prices Input $2.00 & more $1 $3");
	});

	test("caps the text", () => {
		expect(pageText("a ".repeat(PAGE_TEXT_MAX_CHARS))).toHaveLength(
			PAGE_TEXT_MAX_CHARS,
		);
	});
});
