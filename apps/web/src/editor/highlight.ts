/**
 * Highlighting for the Markdown preview's fenced code (SPEC.md §13.4), done by
 * Monaco's own tokenizer so the bundle gains nothing new. Monaco hands back
 * HTML, and the preview runs on the app's origin with the student's file as
 * untrusted input (SPEC.md §24.2, §24.3), so that HTML is never inserted.
 * It is read in an inert document and only token class names and text come
 * out of it.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { colorizeFence, currentThemeName, onThemeChange } from "./monaco.js";

/** A run of code text and the Monaco token class that colours it, if any. */
export interface TokenRun {
	className?: string;
	text: string;
}

/** Monaco's token classes: a colour index, then italic, bold, underline or strike. */
const TOKEN_CLASS = /^mtk\d+( mtk[ibus])*$/;

/**
 * The text and token classes in Monaco's colorize output. Only a span's
 * token class survives; every other element, attribute and class is dropped
 * and only its text kept. Monaco's line breaks become newlines and its non-breaking
 * spaces plain ones, so copied code is the code in the file.
 */
export function tokenRuns(html: string): TokenRun[] {
	// DOMParser builds an inert document: nothing in it loads or runs.
	const doc = new DOMParser().parseFromString(html, "text/html");
	const runs: TokenRun[] = [];
	const push = (text: string, className: string | undefined) => {
		if (text === "") return;
		const plain = text.replace(/ /g, " ");
		const last = runs.at(-1);
		if (last && last.className === className) last.text += plain;
		else
			runs.push(className === undefined ? { text: plain } : { className, text: plain });
	};
	const walk = (node: Node, className: string | undefined) => {
		for (const child of Array.from(node.childNodes)) {
			if (child.nodeType === Node.TEXT_NODE) {
				push(child.textContent ?? "", className);
			} else if (child instanceof Element) {
				const tag = child.tagName.toLowerCase();
				if (tag === "br") {
					push("\n", undefined);
				} else {
					const own = child.getAttribute("class") ?? "";
					walk(child, tag === "span" && TOKEN_CLASS.test(own) ? own : className);
				}
			}
		}
	};
	walk(doc.body, undefined);
	// Monaco ends every line with a break, the last one included.
	const last = runs.at(-1);
	if (last?.className === undefined && last?.text.endsWith("\n")) {
		last.text = last.text.slice(0, -1);
		if (last.text === "") runs.pop();
	}
	return runs;
}

/** Enough blocks for a long README without the cache growing without end. */
const CACHE_LIMIT = 200;
const cache = new Map<string, TokenRun[] | null>();

function cacheKey(code: string, fence: string, theme: string): string {
	return `${theme}\u0000${fence}\u0000${code}`;
}

function remember(key: string, runs: TokenRun[] | null): void {
	if (cache.size >= CACHE_LIMIT) {
		const oldest = cache.keys().next().value;
		if (oldest !== undefined) cache.delete(oldest);
	}
	cache.set(key, runs);
}

/**
 * The highlighted runs of a fenced block, or null while they load and when
 * the fence names no language Monaco knows. Highlighting again follows the
 * code, the fence and the page's theme, because the token classes index the
 * current theme's colours.
 */
export function useHighlight(code: string, fence: string): TokenRun[] | null {
	const theme = useSyncExternalStore(onThemeChange, currentThemeName);
	const key = cacheKey(code, fence, theme);
	const [loaded, setLoaded] = useState<{ key: string; runs: TokenRun[] | null } | null>(
		null,
	);
	const cached = cache.get(key);
	useEffect(() => {
		if (cache.has(key)) return;
		let current = true;
		colorizeFence(code, fence).then(
			(html) => {
				const runs = html === null ? null : tokenRuns(html);
				remember(key, runs);
				if (current) setLoaded({ key, runs });
			},
			// A block that cannot be highlighted still reads as plain code.
			() => {
				if (current) setLoaded({ key, runs: null });
			},
		);
		return () => {
			current = false;
		};
	}, [key, code, fence]);
	if (cached !== undefined) return cached;
	return loaded?.key === key ? loaded.runs : null;
}
