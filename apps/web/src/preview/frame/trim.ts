import { PICK_HTML_MAX_CHARS, PICK_HTML_TRIMMED_MARKER } from "../pick/messages.js";

const TEXT_MAX_CHARS = 500;
const ATTRIBUTE_MAX_CHARS = 200;
const MAX_DEPTH = 6;
const ELLIPSIS = "…";
const VOID_ELEMENTS = new Set([
	"area",
	"base",
	"br",
	"col",
	"embed",
	"hr",
	"img",
	"input",
	"link",
	"meta",
	"source",
	"track",
	"wbr",
]);
const BODY_DROPPED = new Set(["script", "style"]);

const escapeText = (text: string) =>
	text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttribute = (text: string) =>
	text.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

/** The element's outer HTML cut to the pick limits, and whether anything was cut. */
export function trimHtml(element: Element): { html: string; trimmed: boolean } {
	let trimmed = false;
	const cut = (text: string, max: number) => {
		if (text.length <= max) return text;
		trimmed = true;
		return text.slice(0, max) + ELLIPSIS;
	};

	const serialize = (node: Node, depth: number): string => {
		if (node.nodeType === Node.TEXT_NODE) {
			return escapeText(cut(node.nodeValue ?? "", TEXT_MAX_CHARS));
		}
		if (node.nodeType !== Node.ELEMENT_NODE) return "";
		const el = node as Element;
		if (depth > MAX_DEPTH) {
			trimmed = true;
			return "<!-- deeper content left out -->";
		}
		const tag = el.localName;
		const attributes = Array.from(el.attributes)
			.map((a) => ` ${a.name}="${escapeAttribute(cut(a.value, ATTRIBUTE_MAX_CHARS))}"`)
			.join("");
		const open = `<${tag}${attributes}>`;
		if (VOID_ELEMENTS.has(tag)) return open;
		let inner: string;
		if (BODY_DROPPED.has(tag)) {
			inner = el.childNodes.length > 0 ? "<!-- body left out -->" : "";
		} else {
			inner = Array.from(el.childNodes)
				.map((child) => serialize(child, depth + 1))
				.join("");
		}
		return `${open}${inner}</${tag}>`;
	};

	let html = serialize(element, 1);
	if (html.length > PICK_HTML_MAX_CHARS) {
		trimmed = true;
		html = html.slice(0, PICK_HTML_MAX_CHARS) + PICK_HTML_TRIMMED_MARKER;
	}
	return { html, trimmed };
}
