import { describe, expect, it } from "vitest";
import {
	PICK_COMPUTED_PROPERTIES,
	PICK_COMPUTED_VALUE_MAX_CHARS,
	PICK_HOVER_LABEL_MAX_CHARS,
	PICK_HTML_MAX_CHARS,
	PICK_HTML_TRIMMED_MARKER,
	PICK_PNG_MAX_BYTES,
	PICK_RULES_MAX_CHARS,
	PICK_RULES_MAX_COUNT,
	PICK_SELECTOR_MAX_CHARS,
	PICK_TAG_MAX_CHARS,
	parseParentMessage,
	parseWrapperMessage,
} from "./messages.js";

function goodPick(overrides: Record<string, unknown> = {}) {
	return {
		v: 1,
		type: "picked",
		pagePath: "/index.html",
		selector: "main > button.save",
		tag: "button",
		html: '<button class="save">Save</button>',
		rules: [
			{
				kind: "rule",
				selector: ".save",
				declarations: "color: red;",
				media: "(min-width: 600px)",
				sheet: "/style.css",
			},
			{ kind: "unreadable", sheet: "https://cdn.example/lib.css" },
		],
		computed: { color: "rgb(255, 0, 0)", display: "block" },
		trimmed: { html: false, rules: false },
		...overrides,
	};
}

describe("wrapper messages", () => {
	it("accepts a good pick", () => {
		const parsed = parseWrapperMessage(goodPick({ png: new ArrayBuffer(8) }));
		expect(parsed?.type).toBe("picked");
	});

	it("accepts the short messages", () => {
		expect(parseWrapperMessage({ v: 1, type: "cancelled" })).toEqual({
			v: 1,
			type: "cancelled",
		});
		expect(parseWrapperMessage({ v: 1, type: "hover", label: "button Save" })).toEqual({
			v: 1,
			type: "hover",
			label: "button Save",
		});
	});

	it("refuses a wrong or missing version", () => {
		expect(parseWrapperMessage({ v: 2, type: "cancelled" })).toBeNull();
		expect(parseWrapperMessage({ type: "cancelled" })).toBeNull();
		expect(parseWrapperMessage(goodPick({ v: 2 }))).toBeNull();
	});

	it("refuses the retired loaded message", () => {
		expect(parseWrapperMessage({ v: 1, type: "loaded" })).toBeNull();
	});

	it("refuses messages meant for the other direction", () => {
		expect(parseWrapperMessage({ v: 1, type: "start" })).toBeNull();
		expect(parseParentMessage({ v: 1, type: "picked" })).toBeNull();
	});

	it("refuses extra fields on every message", () => {
		expect(parseWrapperMessage({ v: 1, type: "cancelled", extra: 1 })).toBeNull();
		expect(parseWrapperMessage(goodPick({ extra: 1 }))).toBeNull();
	});

	it("refuses a hover label over the limit and takes one at the limit", () => {
		const label = "a".repeat(PICK_HOVER_LABEL_MAX_CHARS);
		expect(parseWrapperMessage({ v: 1, type: "hover", label })).not.toBeNull();
		expect(parseWrapperMessage({ v: 1, type: "hover", label: `${label}a` })).toBeNull();
	});

	it("limits the HTML to its cap plus the trimmed marker", () => {
		const atLimit = "a".repeat(PICK_HTML_MAX_CHARS) + PICK_HTML_TRIMMED_MARKER;
		expect(parseWrapperMessage(goodPick({ html: atLimit }))).not.toBeNull();
		expect(parseWrapperMessage(goodPick({ html: `${atLimit}a` }))).toBeNull();
	});

	it("limits the selector and the tag", () => {
		expect(
			parseWrapperMessage(goodPick({ selector: "a".repeat(PICK_SELECTOR_MAX_CHARS) })),
		).not.toBeNull();
		expect(
			parseWrapperMessage(
				goodPick({ selector: "a".repeat(PICK_SELECTOR_MAX_CHARS + 1) }),
			),
		).toBeNull();
		expect(
			parseWrapperMessage(goodPick({ tag: "a".repeat(PICK_TAG_MAX_CHARS) })),
		).not.toBeNull();
		expect(
			parseWrapperMessage(goodPick({ tag: "a".repeat(PICK_TAG_MAX_CHARS + 1) })),
		).toBeNull();
	});

	it.each(["Button", "1div", "div span", "div\n", "", "<script>", "my_tag", "a`b"])(
		"refuses the tag %j",
		(tag) => {
			expect(parseWrapperMessage(goodPick({ tag }))).toBeNull();
		},
	);

	it.each(["div", "my-element", "h1", "svg"])("accepts the tag %j", (tag) => {
		expect(parseWrapperMessage(goodPick({ tag }))).not.toBeNull();
	});

	it("limits the number of rules", () => {
		const rule = { kind: "rule", selector: "a", declarations: "b" };
		expect(
			parseWrapperMessage(goodPick({ rules: Array(PICK_RULES_MAX_COUNT).fill(rule) })),
		).not.toBeNull();
		expect(
			parseWrapperMessage(
				goodPick({ rules: Array(PICK_RULES_MAX_COUNT + 1).fill(rule) }),
			),
		).toBeNull();
	});

	it("limits the rule text in all, not only per rule", () => {
		const big = (size: number) => ({
			kind: "rule",
			selector: "a",
			declarations: "x".repeat(size - 1),
		});
		const half = PICK_RULES_MAX_CHARS / 2;
		expect(
			parseWrapperMessage(goodPick({ rules: [big(half), big(half)] })),
		).not.toBeNull();
		expect(
			parseWrapperMessage(goodPick({ rules: [big(half), big(half + 1)] })),
		).toBeNull();
	});

	it("counts stylesheet addresses and media conditions toward the rule text", () => {
		const rule = {
			kind: "rule",
			selector: "a",
			declarations: "x".repeat(PICK_RULES_MAX_CHARS - 1 - 400),
			media: "m".repeat(400),
			sheet: "s",
		};
		expect(parseWrapperMessage(goodPick({ rules: [rule] }))).toBeNull();
		expect(
			parseWrapperMessage(goodPick({ rules: [{ ...rule, sheet: undefined }] })),
		).not.toBeNull();
	});

	it("refuses a rule entry of an unknown kind or with extra fields", () => {
		expect(
			parseWrapperMessage(goodPick({ rules: [{ kind: "import", selector: "a" }] })),
		).toBeNull();
		expect(
			parseWrapperMessage(
				goodPick({ rules: [{ kind: "unreadable", sheet: "x", extra: 1 }] }),
			),
		).toBeNull();
	});

	it("accepts every allowed computed property and refuses any other key", () => {
		const all = Object.fromEntries(PICK_COMPUTED_PROPERTIES.map((name) => [name, "x"]));
		expect(parseWrapperMessage(goodPick({ computed: all }))).not.toBeNull();
		expect(
			parseWrapperMessage(goodPick({ computed: { color: "red", "--secret": "x" } })),
		).toBeNull();
		expect(parseWrapperMessage(goodPick({ computed: { content: "x" } }))).toBeNull();
	});

	it("limits each computed value", () => {
		const ok = "a".repeat(PICK_COMPUTED_VALUE_MAX_CHARS);
		expect(parseWrapperMessage(goodPick({ computed: { color: ok } }))).not.toBeNull();
		expect(parseWrapperMessage(goodPick({ computed: { color: `${ok}a` } }))).toBeNull();
	});

	it("leaves the screenshot size to the page, and limits its type", () => {
		// An over-size picture must drop only the picture, not the whole pick.
		expect(
			parseWrapperMessage(goodPick({ png: new ArrayBuffer(PICK_PNG_MAX_BYTES + 1) })),
		).not.toBeNull();
		expect(
			parseWrapperMessage(goodPick({ png: "data:image/png;base64,AAAA" })),
		).toBeNull();
		expect(parseWrapperMessage(goodPick({ png: new Uint8Array(8) }))).toBeNull();
	});

	it("needs the trimmed flags and an array of rules", () => {
		expect(parseWrapperMessage(goodPick({ trimmed: undefined }))).toBeNull();
		expect(parseWrapperMessage(goodPick({ rules: "a { }" }))).toBeNull();
	});

	it.each([
		null,
		undefined,
		0,
		"picked",
		[],
		{},
		{ v: 1 },
		{ v: 1, type: "nope" },
		new Date(),
	])("returns null for junk %#", (junk) => {
		expect(parseWrapperMessage(junk)).toBeNull();
		expect(parseParentMessage(junk)).toBeNull();
	});

	it("never throws, even when reading a field throws", () => {
		const hostile = {
			get type(): string {
				throw new Error("boom");
			},
		};
		expect(parseWrapperMessage(hostile)).toBeNull();
		expect(parseParentMessage(hostile)).toBeNull();
	});
});

describe("parent messages", () => {
	it("accepts start and stop", () => {
		expect(parseParentMessage({ v: 1, type: "start" })).toEqual({
			v: 1,
			type: "start",
		});
		expect(parseParentMessage({ v: 1, type: "stop" })).toEqual({ v: 1, type: "stop" });
	});

	it("refuses a wrong version and extra fields", () => {
		expect(parseParentMessage({ v: 0, type: "start" })).toBeNull();
		expect(parseParentMessage({ v: 1, type: "start", target: "x" })).toBeNull();
	});
});
