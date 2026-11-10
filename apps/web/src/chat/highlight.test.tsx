import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { ChatMarkdown } from "./ChatMarkdown";
import { DiffBlock } from "./CodeBlocks";
import {
	fenceTag,
	languageFor,
	languageForPath,
	loadHighlighter,
	MAX_HIGHLIGHT_CHARS,
	parseHighlighted,
	tokensFor,
} from "./highlight";

afterEach(cleanup);

describe("languages", () => {
	test("fence tags and extensions name the dozen languages we colour", () => {
		expect(languageFor("py")).toEqual({ id: "python", label: "Python" });
		expect(languageFor("TSX")?.id).toBe("typescript");
		expect(languageFor("html")).toEqual({ id: "xml", label: "HTML" });
		expect(languageFor("sh")?.label).toBe("Shell");
		expect(languageFor("c++")?.id).toBe("cpp");
		expect(languageFor("rust")).toBeNull();
		expect(languageFor(undefined)).toBeNull();
		expect(languageFor("toString")).toBeNull();
	});

	test("a file's language comes from its extension alone", () => {
		expect(languageForPath("src/App.java")?.id).toBe("java");
		expect(languageForPath("/home/s/a.b/main.c")?.id).toBe("c");
		expect(languageForPath("Makefile")).toBeNull();
		expect(languageForPath(".bashrc")).toBeNull();
		expect(languageForPath("notes.txt")).toBeNull();
	});

	test("the fence tag is read from Markdown's language- class", () => {
		expect(fenceTag(["language-python"])).toBe("python");
		expect(fenceTag("x language-js")).toBe("js");
		expect(fenceTag(undefined)).toBeUndefined();
		expect(fenceTag(["language-"])).toBeUndefined();
	});
});

// SPEC.md §24.3: reply text is untrusted, so the highlighter's HTML is read
// back as spans and text and never set as markup.
describe("reading the highlighter's output", () => {
	test("spans become scoped text and entities are unescaped", () => {
		expect(
			parseHighlighted('<span class="hljs-keyword">if</span> a &lt; b &amp;&amp; c'),
		).toEqual([
			{ text: "if", scope: "hljs-keyword" },
			{ text: " a < b && c", scope: "" },
		]);
		expect(parseHighlighted('<span class="hljs-title function_">f</span>')).toEqual([
			{ text: "f", scope: "hljs-title function_" },
		]);
	});

	test("anything but its own spans means plain text", () => {
		expect(parseHighlighted("<b>x</b>")).toBeNull();
		expect(parseHighlighted('<span class="x" onclick="y">x</span>')).toBeNull();
		expect(parseHighlighted('<span class="hljs-string">open')).toBeNull();
		expect(parseHighlighted("</span>")).toBeNull();
	});

	test("code that looks like markup stays text", async () => {
		const highlight = await loadHighlighter();
		const html = languageFor("html");
		if (!html) throw new Error("html is a known language");
		const tokens = tokensFor(highlight, '<img src=x onerror="alert(1)">', html);
		expect(tokens?.map((t) => t.text).join("")).toBe('<img src=x onerror="alert(1)">');
	});

	test("a very long block stays plain", async () => {
		const highlight = await loadHighlighter();
		const py = languageFor("py");
		if (!py) throw new Error("python is a known language");
		expect(tokensFor(highlight, "x = 1\n".repeat(MAX_HIGHLIGHT_CHARS), py)).toBeNull();
		expect(tokensFor(highlight, "x = 1", py)).not.toBeNull();
	});
});

describe("fenced code in a reply", () => {
	test("a known language is named and coloured, keeping the text as written", async () => {
		const code = 'def greet(name):\n    return "hi " + name  # say hi';
		const { container } = render(
			<ChatMarkdown text={`\`\`\`python\n${code}\n\`\`\``} />,
		);
		expect(screen.getByText("Python")).toBeTruthy();
		const pre = container.querySelector("pre");
		await waitFor(() => expect(pre?.querySelector(".hljs-keyword")).not.toBeNull());
		expect(pre?.querySelector(".hljs-string")?.textContent).toBe('"hi "');
		expect(pre?.querySelector(".hljs-comment")?.textContent).toBe("# say hi");
		expect(pre?.textContent).toBe(`${code}\n`);
		expect(pre?.getAttribute("tabindex")).toBe("0");
	});

	test("an unknown language is named as written and never coloured", async () => {
		const { container } = render(
			<ChatMarkdown
				text={"```rust\nfn main() { let x = 1; }\n```\n\n```py\nx = 1\n```"}
			/>,
		);
		expect(screen.getByText("rust")).toBeTruthy();
		await waitFor(() => expect(container.querySelector(".hljs-number")).not.toBeNull());
		const rust = container.querySelectorAll("pre")[0];
		expect(rust?.querySelector("[class^=hljs]")).toBeNull();
		expect(rust?.textContent).toBe("fn main() { let x = 1; }\n");
	});

	test("a block with no tag has no label and no colour", async () => {
		const { container } = render(<ChatMarkdown text={"```\nlet x = 1;\n```"} />);
		expect(container.querySelector(".pk-chat-lang")).toBeNull();
		await loadHighlighter();
		expect(container.querySelector("[class^=hljs]")).toBeNull();
	});
});

describe("an edit diff", () => {
	const changes = [{ before: "x = 1", after: "x = 2" }];

	test("with a path, lines are coloured in the file's language and keep their marks", async () => {
		const { getByTestId } = render(<DiffBlock changes={changes} path="src/app.py" />);
		expect(screen.getByText("Python")).toBeTruthy();
		const diff = getByTestId("chat-diff");
		await waitFor(() => expect(diff.querySelector(".hljs-number")).not.toBeNull());
		const lines = [...diff.querySelectorAll(".pk-chat-diff-line")].map(
			(l) => l.textContent,
		);
		expect(lines).toEqual(["- x = 1\n", "+ x = 2\n"]);
	});

	test("the scrolling box is named by its language label, then 'diff'", () => {
		const { getByTestId } = render(<DiffBlock changes={changes} path="src/app.ts" />);
		expect(
			getByTestId("chat-diff").getAttribute("aria-labelledby")?.split(" "),
		).toHaveLength(2);
		expect(
			screen.getByRole("group", { hidden: true, name: "TypeScript diff" }),
		).toBeTruthy();
	});

	test("without a path, or with an unknown one, the lines stay plain", async () => {
		const plain = render(<DiffBlock changes={changes} />);
		const other = render(<DiffBlock changes={changes} path="notes.txt" />);
		await loadHighlighter();
		for (const view of [plain, other]) {
			expect(view.container.querySelector("[class^=hljs], .pk-chat-lang")).toBeNull();
		}
	});
});
