/**
 * Turns a reply's Markdown into text for the browser to speak (ADR 0071).
 * It parses with the same react-markdown and GFM plugin the chat renders
 * with, so what is read matches what is shown.
 */
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Chrome stops an utterance after about 15 seconds, so chunks stay short. */
export const MAX_CHUNK = 200;

/** The few mdast fields read here; no @types/mdast dependency. */
interface MdNode {
	type: string;
	value?: string;
	alt?: string | null;
	children?: MdNode[];
}

/** Parses with the chat's plugins and hands back the Markdown tree. */
function parse(markdown: string): MdNode {
	let tree: MdNode = { type: "root", children: [] };
	const capture = () => (root: MdNode) => {
		tree = root;
	};
	// The sync component is a plain function (no hooks); called directly it
	// runs the parser, and the captured tree is all that is wanted.
	Markdown({ children: markdown, remarkPlugins: [remarkGfm, capture] });
	return tree;
}

function inline(node: MdNode): string {
	switch (node.type) {
		case "text":
		case "inlineCode":
			return node.value ?? "";
		case "break":
			return " ";
		case "image":
		case "imageReference":
			return node.alt ?? "";
		case "html":
		case "footnoteReference":
			return "";
		default:
			return (node.children ?? []).map(inline).join("");
	}
}

function sentence(text: string): string {
	const trimmed = text.replace(/\s+/g, " ").trim();
	if (trimmed === "") return "";
	return /[.!?:;]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function blocks(node: MdNode): string[] {
	switch (node.type) {
		case "code":
			return ["Code block."];
		case "paragraph":
		case "heading":
			return [sentence(inline(node))];
		case "tableRow":
			return [sentence((node.children ?? []).map((cell) => inline(cell).trim()).join(", "))];
		case "html":
		case "thematicBreak":
		case "definition":
		case "footnoteDefinition":
			return [];
		default:
			return (node.children ?? []).flatMap(blocks);
	}
}

/** The reply's words, Markdown removed, one block per paragraph. */
export function toSpeechText(markdown: string): string {
	return blocks(parse(markdown))
		.filter((block) => block !== "")
		.join("\n\n");
}

function sentences(paragraph: string): string[] {
	const segmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });
	return Array.from(segmenter.segment(paragraph), (s) => s.segment.trim()).filter(Boolean);
}

/** Splits text longer than a chunk at spaces, or hard when there are none. */
function splitLong(text: string): string[] {
	const out: string[] = [];
	let rest = text;
	while (rest.length > MAX_CHUNK) {
		const space = rest.lastIndexOf(" ", MAX_CHUNK);
		const cut = space > 0 ? space : MAX_CHUNK;
		out.push(rest.slice(0, cut));
		rest = rest.slice(cut).trimStart();
	}
	if (rest) out.push(rest);
	return out;
}

/** The reply as short utterances: sentences grouped up to a chunk, per paragraph. */
export function toSpeechChunks(markdown: string): string[] {
	const chunks: string[] = [];
	for (const paragraph of toSpeechText(markdown).split("\n\n")) {
		let current = "";
		for (const piece of sentences(paragraph).flatMap(splitLong)) {
			if (current && current.length + 1 + piece.length <= MAX_CHUNK) {
				current = `${current} ${piece}`;
			} else {
				if (current) chunks.push(current);
				current = piece;
			}
		}
		if (current) chunks.push(current);
	}
	return chunks;
}
