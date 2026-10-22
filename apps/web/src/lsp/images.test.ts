import { expect, test } from "vitest";
import { sanitizeMarkdown, toMarkdown } from "./content.js";
import { escapeImages } from "./images.js";

// Hover text is untrusted (SPEC.md §13.6, §24.3): an image loads from any
// https host the CSP allows, so a doubtful "![" is always escaped.

test("prose images are escaped, with the alt text kept", () => {
	expect(escapeImages("a ![tracker](https://evil.example/p.png) b")).toBe(
		"a !\\[tracker](https://evil.example/p.png) b",
	);
});

test("a fenced block keeps its characters as they are", () => {
	const md = "```typescript\nconst a = b![0];\n```\n\nafter ![x](u)";
	expect(escapeImages(md)).toBe(
		"```typescript\nconst a = b![0];\n```\n\nafter !\\[x](u)",
	);
	expect(escapeImages("~~~\nx![0]\n~~~")).toBe("~~~\nx![0]\n~~~");
	expect(escapeImages("````\n```\nx![0]\n```\n````")).toBe(
		"````\n```\nx![0]\n```\n````",
	);
});

test("an unclosed fence runs to the end, as the renderer reads it", () => {
	expect(escapeImages("```\nx![0]")).toBe("```\nx![0]");
});

test("the text after the fence marks is not code", () => {
	expect(escapeImages("```py ![x](https://evil.example/p.png)\nok\n```")).toBe(
		"```py !\\[x](https://evil.example/p.png)\nok\n```",
	);
});

test("a code span keeps its characters, and the text around it is escaped", () => {
	expect(escapeImages("Use `x![0]` or ![a](u).")).toBe("Use `x![0]` or !\\[a](u).");
	expect(escapeImages("Use ``a ` ![0]`` here")).toBe("Use ``a ` ![0]`` here");
});

test("a code span without a closer is plain text", () => {
	expect(escapeImages("a `b ![x](u)")).toBe("a `b !\\[x](u)");
});

test("anything the renderer might read differently is escaped", () => {
	const doubtful: Record<string, string> = {
		"a table row splits at its pipes": "| ` | ![x](https://e.example/p.png) | `",
		"a tag can hold the backtick": '<a title="`">![x](https://e.example/p.png)`',
		"a link destination can hold the backtick":
			"[a](`) ![x](https://e.example/p.png) `",
		"emphasis can span the backticks": "_a ``b_ ![x](https://e.example/p.png) ``",
		"strikethrough can span the backticks": "~~a`b~~![x](https://e.example/p.png)`",
		"an address can hold the backtick":
			"see https://a.example/` ![x](https://e.example/p.png) `",
		"an escaped backtick shortens the run":
			"\\``.com(\n`![x](https://e.example/p.png)[x](u)`)`",
		"a span cannot start on one line and end on another":
			"``\n:``---![![x](https://e.example/p.png)``",
		"a fence inside a quote": "> ```\n![x](https://e.example/p.png)\n> ```",
		"an indented fence": "  ```\nx\n```\n![x](https://e.example/p.png)\n```",
		"a fence after an HTML block": "<div>\n```\n\n![x](https://e.example/p.png)\n```",
		"a fence ended by mixed marks": "~~~\n`\n~~~`\n![x](https://e.example/p.png)",
		"a definition label that runs over a fence":
			"[a\n````x]: u![x](https://e.example/p.png)\n\n![x](https://e.example/p.png)",
		"a backtick in a fence's first line": "```a`\n![x](https://e.example/p.png)\n```",
	};
	for (const [why, md] of Object.entries(doubtful)) {
		expect(escapeImages(md), why).not.toContain("![");
		expect(escapeImages(md), why).toContain("!\\[");
	}
});

test("carriage returns end a line, as they do in the renderer", () => {
	expect(escapeImages("```\r\nx![0]\r\n```\r\n![a](u)")).toBe(
		"```\nx![0]\n```\n!\\[a](u)",
	);
});

test("removing an img tag cannot join the pieces of an image", () => {
	expect(sanitizeMarkdown("!<img src=x>[a](https://evil.example/p.png)")).not.toContain(
		"![",
	);
});

test("hover Markdown shows no backslash in code, and still no image outside it", () => {
	const [part] = toMarkdown({
		kind: "markdown",
		value:
			"```typescript\nconst a = b![0];\n```\n\nSee `c![1]` and ![t](https://evil.example/p.png).",
	});
	expect(part?.value).toBe(
		"```typescript\nconst a = b![0];\n```\n\nSee `c![1]` and !\\[t](https://evil.example/p.png).",
	);
});
