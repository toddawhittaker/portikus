/**
 * Routing, protocol mapping and the untrusted-content rules (SPEC.md §13.6).
 */
import type * as Monaco from "monaco-editor";
import { expect, test } from "vitest";
import { statusView, TOO_LARGE_MESSAGE } from "./CodeHelpStatus.js";
import { sanitizeMarkdown, toMarkdown } from "./content.js";
import {
	definitionTargets,
	fromRange,
	pathFromServerUri,
	serverUri,
	toCompletion,
	toRange,
} from "./protocol.js";
import { lspLanguageId, serverFor, serversForLanguage } from "./servers.js";

test("Python Format goes to ruff and the rest of Python to python", () => {
	expect(serverFor("python", "format")).toBe("ruff");
	for (const feature of [
		"completion",
		"hover",
		"definition",
		"rename",
		"diagnostics",
	] as const) {
		expect(serverFor("python", feature)).toBe("python");
	}
	expect(serversForLanguage("python")).toEqual(["python", "ruff"]);
});

test("all TypeScript and JavaScript features go to typescript", () => {
	for (const language of ["typescript", "javascript"]) {
		expect(serverFor(language, "format")).toBe("typescript");
		expect(serverFor(language, "completion")).toBe("typescript");
		expect(serversForLanguage(language)).toEqual(["typescript"]);
	}
	expect(serverFor("markdown", "completion")).toBeNull();
	expect(serversForLanguage("json")).toEqual([]);
	expect(lspLanguageId("typescript", "src/App.tsx")).toBe("typescriptreact");
	expect(lspLanguageId("javascript", "a.js")).toBe("javascript");
});

test("ranges differ only by one-based numbering", () => {
	const monaco = { startLineNumber: 3, startColumn: 5, endLineNumber: 4, endColumn: 1 };
	const lsp = { start: { line: 2, character: 4 }, end: { line: 3, character: 0 } };
	expect(toRange(monaco)).toEqual(lsp);
	expect(fromRange(lsp)).toEqual(monaco);
});

test("server URIs map to project paths, and anything outside is null", () => {
	const root = "/home/student/projects/my app";
	const uri = serverUri(root, "src/a b.py");
	expect(uri).toBe("file:///home/student/projects/my%20app/src/a%20b.py");
	expect(pathFromServerUri(root, uri)).toBe("src/a b.py");
	expect(pathFromServerUri(root, "file:///home/student/projects/my app/x.py")).toBe(
		"x.py",
	);
	expect(pathFromServerUri(root, "file:///usr/lib/python3/os.py")).toBeNull();
	expect(
		pathFromServerUri(root, "file:///home/student/projects/my app2/x.py"),
	).toBeNull();
	expect(
		pathFromServerUri(root, "file:///home/student/projects/my app/../x.py"),
	).toBeNull();
	expect(pathFromServerUri(root, "untitled:x")).toBeNull();
});

test("definition results of every shape become targets", () => {
	const range = { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } };
	expect(definitionTargets(null)).toEqual([]);
	expect(definitionTargets({ uri: "file:///a", range })).toEqual([
		{ uri: "file:///a", range },
	]);
	expect(
		definitionTargets([
			{ targetUri: "file:///b", targetRange: range, targetSelectionRange: range },
		]),
	).toEqual([{ uri: "file:///b", range }]);
});

const fakeMonaco = {
	languages: { CompletionItemKind: { Text: 18, Function: 1, Method: 0 } },
} as unknown as typeof Monaco;
const wordRange = {
	startLineNumber: 1,
	startColumn: 1,
	endLineNumber: 1,
	endColumn: 3,
};

test("a completion uses the server's edit range, and a snippet is inserted as plain text", () => {
	const item = toCompletion(
		fakeMonaco,
		{
			label: "print",
			kind: 3,
			insertTextFormat: 2,
			textEdit: {
				range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } },
				newText: "print($1)",
			},
		},
		wordRange,
	);
	expect(item.kind).toBe(1);
	expect(item.insertText).toBe("print($1)");
	expect(item.insertTextRules).toBeUndefined();
	expect(item.range).toEqual(wordRange);
	const plain = toCompletion(fakeMonaco, { label: "pr" }, wordRange);
	expect(plain.insertText).toBe("pr");
	expect(plain.kind).toBe(18);
});

test("hover Markdown is never trusted and never HTML", () => {
	const [part] = toMarkdown({ kind: "markdown", value: "**hi**" });
	expect(part).toEqual({
		value: "**hi**",
		isTrusted: false,
		supportHtml: false,
		supportThemeIcons: false,
	});
});

test("every image form is escaped in hover Markdown, keeping its alt text", () => {
	// An unescaped "![" is the start of every image form CommonMark has.
	const unescapedImage = /(^|[^\\])!\[/;
	for (const markdown of [
		"a ![tracker](https://evil.example/p.png) b",
		"![full][1]\n\n[1]: https://evil.example/p.png",
		"![collapsed][]\n\n[collapsed]: https://evil.example/p.png",
		"![shortcut]\n\n[shortcut]: https://evil.example/p.png",
		"![x](javascript:alert)",
	]) {
		const safe = sanitizeMarkdown(markdown);
		expect(safe, markdown).not.toMatch(unescapedImage);
		expect(safe).toMatch(/tracker|full|collapsed|shortcut|x/);
	}
	expect(sanitizeMarkdown("a ![tracker](https://evil.example/p.png) b")).toBe(
		"a !\\[tracker](https://evil.example/p.png) b",
	);
	expect(sanitizeMarkdown('x <img src="https://evil.example/p.png"> y')).toBe("x  y");
});

test("only http and https links are kept", () => {
	expect(sanitizeMarkdown("[docs](https://docs.python.org)")).toBe(
		"[docs](https://docs.python.org)",
	);
	expect(sanitizeMarkdown("[run](command:workbench.action.reload)")).toBe("run");
	expect(sanitizeMarkdown("[x](javascript:alert)")).toBe("x");
	expect(sanitizeMarkdown("[f](file:///etc/passwd)")).toBe("f");
	expect(sanitizeMarkdown("<command:x>")).toBe("command:x");
	expect(sanitizeMarkdown("[1]: command:x")).toBe("");
});

test("a link after a literal backslash is still filtered", () => {
	// "\\" is an escaped backslash, so the "[" after it starts a real link.
	expect(sanitizeMarkdown("\\\\[a](file:///x)")).toBe("\\\\a");
	expect(sanitizeMarkdown("\\\\[a](mailto:x@example.com)")).toBe("\\\\a");
	expect(sanitizeMarkdown("\\\\[a](https://example.com)")).toBe(
		"\\\\[a](https://example.com)",
	);
	// So is one after "!" and a backslash, which a lookbehind for the image escape would skip.
	expect(sanitizeMarkdown("!\\\\[a](file:///x)")).toBe("!\\\\a");
	// An image with a non-http target keeps its alt text and loses the target.
	expect(sanitizeMarkdown("![a](file:///x)")).toBe("!\\a");
});

test("plain text and code blocks cannot become links or HTML", () => {
	const [plain] = toMarkdown({ kind: "plaintext", value: "<b>[x](command:y)</b>" });
	expect(plain?.value).not.toMatch(/\]\(/);
	expect(plain?.value).toContain("\\<b\\>");
	const [code] = toMarkdown({ language: "python`", value: "a```b" });
	expect(code?.value.startsWith("```python\n")).toBe(true);
	expect(code?.value).not.toContain("a```b");
});

test("the editor bar says each state, with the right button", () => {
	expect(statusView(undefined, false)).toBeNull();
	expect(statusView({ state: "quiet" }, true)).toBeNull();
	expect(statusView({ state: "ready" }, true)).toEqual({
		text: TOO_LARGE_MESSAGE,
		action: null,
	});
	expect(TOO_LARGE_MESSAGE).toBe("Code help is off for files over 512 KB");
	expect(statusView({ state: "replaced" }, false)).toEqual({
		text: "Code help is on in another window",
		action: "Use here",
	});
	expect(statusView({ state: "unavailable" }, false)?.action).toBe("Restart");
	expect(
		statusView({ state: "crashed", detail: "It may have run out of memory." }, false),
	).toEqual({
		text: "Code help stopped. It may have run out of memory.",
		action: "Restart",
	});
	expect(statusView({ state: "starting" }, false)?.action).toBeNull();
});
