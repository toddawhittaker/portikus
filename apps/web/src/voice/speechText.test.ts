import { expect, test } from "vitest";
import { MAX_CHUNK, toSpeechChunks, toSpeechText } from "./speechText";

test("emphasis, strong and strikethrough read as plain words", () => {
	expect(toSpeechText("This is **bold**, *soft* and ~~gone~~ text.")).toBe(
		"This is bold, soft and gone text.",
	);
});

test("a link reads as its text, never its address", () => {
	const text = toSpeechText(
		"See [the guide](https://example.com/a/b) and <https://x.org>.",
	);
	expect(text).toBe("See the guide and https://x.org.");
	expect(toSpeechText("[docs][d]\n\n[d]: https://example.com")).toBe("docs.");
});

test("a fenced code block becomes the words code block and is not read", () => {
	const text = toSpeechText(
		"Run this:\n\n```ts\nconst secretListing = 1;\n```\n\nThen go.",
	);
	expect(text).toBe("Run this:\n\nCode block.\n\nThen go.");
	expect(text).not.toContain("secretListing");
	expect(toSpeechText("    indented();\n")).toBe("Code block.");
});

test("inline code reads as its text", () => {
	expect(toSpeechText("Call `npm test` now.")).toBe("Call npm test now.");
});

test("headings and list items each end as a sentence", () => {
	expect(toSpeechText("# Plan\n\n- first step\n- second step!\n\n1. one\n2. two")).toBe(
		"Plan.\n\nfirst step.\n\nsecond step!\n\none.\n\ntwo.",
	);
});

test("a table reads row by row with its cells separated", () => {
	const md = "| Name | Size |\n|---|---|\n| a.ts | 3 |\n| b.ts | 4 |";
	expect(toSpeechText(md)).toBe("Name, Size.\n\na.ts, 3.\n\nb.ts, 4.");
});

test("images read their alt text; raw HTML, rules and footnotes are dropped", () => {
	expect(toSpeechText("![a chart](x.png)")).toBe("a chart.");
	expect(toSpeechText("A<br>B\n\n---\n\nEnd[^1].\n\n[^1]: note")).toBe("AB.\n\nEnd.");
	expect(toSpeechText("> quoted words")).toBe("quoted words.");
	expect(toSpeechText("line one  \nline two")).toBe("line one line two.");
});

test("an empty reply has nothing to say", () => {
	expect(toSpeechText("")).toBe("");
	expect(toSpeechChunks("   ")).toEqual([]);
});

test("a reply splits into sentence chunks, short ones grouped", () => {
	expect(toSpeechChunks("One. Two.\n\nThree is here.")).toEqual([
		"One. Two.",
		"Three is here.",
	]);
	const long = Array.from(
		{ length: 30 },
		(_, i) => `Sentence number ${i} is here.`,
	).join(" ");
	const chunks = toSpeechChunks(long);
	expect(chunks.length).toBeGreaterThan(1);
	for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(MAX_CHUNK);
	expect(chunks.join(" ")).toBe(long);
});

test("one overlong sentence splits on word boundaries", () => {
	const words = Array.from({ length: 80 }, (_, i) => `word${i}`).join(" ");
	const chunks = toSpeechChunks(words);
	expect(chunks.length).toBeGreaterThan(1);
	for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(MAX_CHUNK);
	expect(chunks.join(" ")).toBe(`${words}.`);
	expect(toSpeechChunks("x".repeat(MAX_CHUNK + 5))).toHaveLength(2);
});
