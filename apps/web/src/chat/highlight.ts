/**
 * Syntax colours for code in the chat (ADR 0072). highlight.js core and a
 * dozen languages load only when the first known-language block renders, so
 * the first page and the chat's own chunk stay the same size (SPEC.md
 * §25.1). Until then, and for an unknown language or a very long block, the
 * text is plain; colouring never guesses a language from the content.
 *
 * The highlighter's output is never set as HTML: it is read back into
 * class names and text, and anything but its own spans drops to plain text,
 * because reply text is untrusted (SPEC.md §24.3).
 */
import { useEffect, useState } from "react";

/** A language highlight.js knows, with the label a student reads. */
export interface Language {
	id: LanguageId;
	label: string;
}

type LanguageId =
	| "python"
	| "javascript"
	| "typescript"
	| "java"
	| "c"
	| "cpp"
	| "xml"
	| "css"
	| "json"
	| "sql"
	| "bash"
	| "diff";

const LABELS: Record<LanguageId, string> = {
	python: "Python",
	javascript: "JavaScript",
	typescript: "TypeScript",
	java: "Java",
	c: "C",
	cpp: "C++",
	xml: "HTML",
	css: "CSS",
	json: "JSON",
	sql: "SQL",
	bash: "Shell",
	diff: "Diff",
};

/** Fence tags and file extensions, lower case, each naming one language. */
const ALIASES: Record<string, LanguageId> = {
	python: "python",
	py: "python",
	javascript: "javascript",
	js: "javascript",
	jsx: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	typescript: "typescript",
	ts: "typescript",
	tsx: "typescript",
	mts: "typescript",
	cts: "typescript",
	java: "java",
	c: "c",
	h: "c",
	cpp: "cpp",
	"c++": "cpp",
	cc: "cpp",
	cxx: "cpp",
	hpp: "cpp",
	html: "xml",
	htm: "xml",
	xml: "xml",
	svg: "xml",
	css: "css",
	json: "json",
	sql: "sql",
	bash: "bash",
	sh: "bash",
	shell: "bash",
	zsh: "bash",
	console: "bash",
	diff: "diff",
	patch: "diff",
};

/** Past this size a block stays plain: colouring it would stall the page. */
export const MAX_HIGHLIGHT_CHARS = 20_000;

/** The language a fence tag or file extension names, or null when it is not one we colour. */
export function languageFor(tag: string | undefined): Language | null {
	const id = tag ? ALIASES[tag.toLowerCase()] : undefined;
	return id ? { id, label: LABELS[id] } : null;
}

/** The language of a file, from its extension alone. */
export function languageForPath(path: string): Language | null {
	const name = path.slice(path.lastIndexOf("/") + 1);
	const dot = name.lastIndexOf(".");
	return dot > 0 ? languageFor(name.slice(dot + 1)) : null;
}

/** The tag after a fence's backticks, as Markdown puts it in `language-<tag>`. */
export function fenceTag(className: unknown): string | undefined {
	const names = Array.isArray(className)
		? className
		: String(className ?? "").split(" ");
	for (const name of names) {
		if (typeof name === "string" && name.startsWith("language-")) {
			return name.slice("language-".length) || undefined;
		}
	}
	return undefined;
}

/** A run of code text, with the innermost highlight.js classes it sits in ("" for plain). */
export interface Token {
	text: string;
	scope: string;
}

type Highlight = (code: string, id: LanguageId) => string;

let loaded: Highlight | null = null;
let loading: Promise<Highlight> | null = null;

/** Loads highlight.js and its languages once; later calls share the same load. */
export function loadHighlighter(): Promise<Highlight> {
	loading ??= (async () => {
		const [core, ...languages] = await Promise.all([
			import("highlight.js/lib/core"),
			import("highlight.js/lib/languages/python"),
			import("highlight.js/lib/languages/javascript"),
			import("highlight.js/lib/languages/typescript"),
			import("highlight.js/lib/languages/java"),
			import("highlight.js/lib/languages/c"),
			import("highlight.js/lib/languages/cpp"),
			import("highlight.js/lib/languages/xml"),
			import("highlight.js/lib/languages/css"),
			import("highlight.js/lib/languages/json"),
			import("highlight.js/lib/languages/sql"),
			import("highlight.js/lib/languages/bash"),
			import("highlight.js/lib/languages/diff"),
		]);
		const hljs = core.default.newInstance();
		const ids = Object.keys(LABELS) as LanguageId[];
		ids.forEach((id, at) => {
			const language = languages[at];
			if (language) hljs.registerLanguage(id, language.default);
		});
		const highlight: Highlight = (code, id) =>
			hljs.highlight(code, { language: id, ignoreIllegals: true }).value;
		loaded = highlight;
		return highlight;
	})();
	return loading;
}

const ENTITIES: Record<string, string> = {
	"&amp;": "&",
	"&lt;": "<",
	"&gt;": ">",
	"&quot;": '"',
	"&#x27;": "'",
	"&#39;": "'",
};

/**
 * Reads highlight.js's HTML back into tokens. It holds only `<span
 * class="hljs-…">`, `</span>` and escaped text; anything else means the
 * output is not what we expect, so the caller shows the code plain.
 */
export function parseHighlighted(html: string): Token[] | null {
	const tokens: Token[] = [];
	const scopes: string[] = [];
	const pattern = /<span class="([a-z0-9_ -]+)">|<\/span>|<|[^<]+/gy;
	for (const match of html.matchAll(pattern)) {
		const [part, classes] = match;
		if (classes !== undefined) {
			scopes.push(classes);
		} else if (part === "</span>") {
			if (scopes.pop() === undefined) return null;
		} else if (part === "<") {
			return null;
		} else {
			const text = part.replace(
				/&(amp|lt|gt|quot|#x27|#39);/g,
				(e) => ENTITIES[e] ?? e,
			);
			tokens.push({ text, scope: scopes.at(-1) ?? "" });
		}
	}
	return scopes.length === 0 ? tokens : null;
}

/** The tokens of `code` in `language`, or null while loading and whenever it stays plain. */
export function tokensFor(
	highlight: Highlight,
	code: string,
	language: Language,
): Token[] | null {
	if (code.length > MAX_HIGHLIGHT_CHARS) return null;
	try {
		return parseHighlighted(highlight(code, language.id));
	} catch {
		return null;
	}
}

/**
 * The highlighter, once loaded; null before, and for no language, so the
 * caller draws plain text until then. Drawing either way keeps the same
 * text in the same box, so nothing moves when the colours arrive.
 */
export function useHighlighter(wanted: boolean): Highlight | null {
	const [highlight, setHighlight] = useState<Highlight | null>(() => loaded);
	useEffect(() => {
		if (!wanted || highlight) return;
		let live = true;
		loadHighlighter().then(
			(ready) => {
				if (live) setHighlight(() => ready);
			},
			() => {
				// A failed load leaves the code plain; the next block tries again.
				loading = null;
			},
		);
		return () => {
			live = false;
		};
	}, [wanted, highlight]);
	return wanted ? highlight : null;
}
