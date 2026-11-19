import { afterEach, describe, expect, it } from "vitest";
import { PICK_HTML_MAX_CHARS, PICK_HTML_TRIMMED_MARKER } from "../pick/messages.js";
import { trimHtml } from "./trim.js";

afterEach(() => {
	document.body.innerHTML = "";
});

function element(html: string): Element {
	document.body.innerHTML = html;
	return document.body.firstElementChild as Element;
}

describe("trimHtml", () => {
	it("keeps small HTML as it is", () => {
		const result = trimHtml(
			element(`<p class="x" data-a="1&quot;">Hi &amp; <b>bye</b><br></p>`),
		);
		expect(result).toEqual({
			html: `<p class="x" data-a="1&quot;">Hi &amp; <b>bye</b><br></p>`,
			trimmed: false,
		});
	});

	it("cuts a text node at 500 characters, not at 499", () => {
		expect(trimHtml(element(`<p>${"a".repeat(500)}</p>`)).trimmed).toBe(false);
		const long = trimHtml(element(`<p>${"a".repeat(501)}</p>`));
		expect(long.trimmed).toBe(true);
		expect(long.html).toBe(`<p>${"a".repeat(500)}…</p>`);
	});

	it("cuts an attribute value at 200 characters", () => {
		expect(trimHtml(element(`<p title="${"t".repeat(200)}"></p>`)).trimmed).toBe(false);
		const long = trimHtml(element(`<p title="${"t".repeat(201)}"></p>`));
		expect(long.trimmed).toBe(true);
		expect(long.html).toBe(`<p title="${"t".repeat(200)}…"></p>`);
	});

	it("cuts below six levels deep", () => {
		const six = `${"<div>".repeat(6)}x${"</div>".repeat(6)}`;
		expect(trimHtml(element(six)).trimmed).toBe(false);
		const seven = `${"<div>".repeat(7)}x${"</div>".repeat(7)}`;
		const result = trimHtml(element(seven));
		expect(result.trimmed).toBe(true);
		expect(result.html).not.toContain("x");
		expect(result.html.match(/<div>/g)).toHaveLength(6);
	});

	it("drops script and style bodies", () => {
		const result = trimHtml(
			element(`<div><script>steal()</script><style>p{color:red}</style></div>`),
		);
		expect(result.html).not.toContain("steal");
		expect(result.html).not.toContain("color");
		expect(result.html).toContain("<script>");
	});

	it("cuts the whole at the HTML limit and adds the marker", () => {
		const items = Array.from({ length: 100 }, () => `<p>${"w".repeat(400)}</p>`).join(
			"",
		);
		const result = trimHtml(element(`<div>${items}</div>`));
		expect(result.trimmed).toBe(true);
		expect(result.html.length).toBe(
			PICK_HTML_MAX_CHARS + PICK_HTML_TRIMMED_MARKER.length,
		);
		expect(result.html.endsWith(PICK_HTML_TRIMMED_MARKER)).toBe(true);
	});

	it("leaves comments out", () => {
		expect(trimHtml(element(`<p><!-- secret -->a</p>`)).html).toBe("<p>a</p>");
	});
});
