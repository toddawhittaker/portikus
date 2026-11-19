import { PICK_SELECTOR_MAX_CHARS } from "../pick/messages.js";

function escapeIdent(value: string): string {
	if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
		return CSS.escape(value);
	}
	return value.replace(/^(\d)/, "\\3$1 ").replace(/[^\w-]/g, (c) => `\\${c}`);
}

function isUnique(doc: Document, selector: string): boolean {
	try {
		return doc.querySelectorAll(selector).length === 1;
	} catch {
		return false;
	}
}

function step(element: Element): string {
	const tag = element.localName;
	const parent = element.parentElement;
	if (!parent) return tag;
	const sameTag = Array.from(parent.children).filter(
		(child) => child.localName === tag,
	);
	if (sameTag.length === 1) return tag;
	return `${tag}:nth-of-type(${sameTag.indexOf(element) + 1})`;
}

/** A short CSS selector that matches only this element in its document. */
export function uniqueSelector(element: Element): string {
	const doc = element.ownerDocument;
	if (element.id) {
		const byId = `#${escapeIdent(element.id)}`;
		if (isUnique(doc, byId)) return byId;
	}
	const firstClass = element.classList[0];
	if (firstClass) {
		const byClass = `${element.localName}.${escapeIdent(firstClass)}`;
		if (isUnique(doc, byClass)) return byClass;
	}
	const parts: string[] = [];
	let current: Element | null = element;
	while (current) {
		if (current.id && current !== element) {
			const anchor = `#${escapeIdent(current.id)}`;
			if (isUnique(doc, anchor)) {
				parts.unshift(anchor);
				break;
			}
		}
		parts.unshift(step(current));
		const path = parts.join(" > ");
		if (path.length > PICK_SELECTOR_MAX_CHARS || isUnique(doc, path)) break;
		current = current.parentElement;
	}
	return parts.join(" > ").slice(0, PICK_SELECTOR_MAX_CHARS);
}
