/**
 * Markdown the rich view will not render, shown as its own source text
 * (SPEC.md §13.4, §24.2; ADR 0017).
 *
 * MDXEditor's importer throws `UnrecognizedMarkdownConstructError` for any
 * mdast node no visitor claims, and the whole document after that point is
 * dropped. Raw HTML is exactly that case, because we turn HTML processing
 * off on purpose: a tag a coding agent wrote must never become markup in the
 * control-plane origin. A README with one `<!-- comment -->` or one `<br>`
 * would therefore show only the text above it.
 *
 * The fix is a visitor that claims those nodes and shows them verbatim. The
 * source text is put into the document as text, never as HTML, so no DOM is
 * ever built from it. The original mdast node is kept on the Lexical node
 * and written back out unchanged, so the file round-trips byte for byte.
 *
 * The same node carries images whose address is not http(s) or relative,
 * which we refuse to load.
 */
import {
	addExportVisitor$,
	addImportVisitor$,
	addLexicalNode$,
	type LexicalExportVisitor,
	type MdastImportVisitor,
	realmPlugin,
} from "@mdxeditor/editor";
import {
	$applyNodeReplacement,
	$createParagraphNode,
	$isElementNode,
	type EditorConfig,
	type LexicalNode,
	type NodeKey,
	type SerializedTextNode,
	TextNode,
} from "lexical";

/**
 * The Markdown syntax-tree nodes this file shows as source rather than
 * rendering: a run of raw HTML, and an image. `@types/mdast` is not a
 * dependency of this app, so the two shapes are written out here.
 */
export interface HtmlMdast {
	type: "html";
	value: string;
}
export interface ImageMdast {
	type: "image";
	url: string;
	alt?: string | null;
	title?: string | null;
}
export type VerbatimMdast = HtmlMdast | ImageMdast;

/**
 * True when an image address is safe to hand to the browser: an ordinary web
 * address or a relative path. Anything with another scheme - `javascript:`,
 * `data:`, `vbscript:` - is refused, because a student's file is untrusted
 * content in the control-plane origin (SPEC.md §24.2).
 *
 * Whitespace and control characters are removed first: browsers ignore them
 * inside an address, so `java\nscript:` is a `javascript:` address.
 */
export function isSafeImageSrc(src: string): boolean {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: browsers strip these from URLs, so we must too.
	const cleaned = src.replace(/[\s\u0000-\u001f\u007f]/g, "");
	const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(cleaned);
	if (scheme === null) return true;
	const name = scheme[1]?.toLowerCase();
	return name === "http" || name === "https";
}

/** The text shown in the rich view for a node we do not render. */
export function verbatimText(node: VerbatimMdast): string {
	if (node.type === "html") return node.value;
	const alt = node.alt ?? "";
	return `![${alt}](${node.url})`;
}

const VERBATIM_TYPE = "portikus-verbatim";

/**
 * A run of text the student sees but cannot edit character by character
 * ("token" mode), so the source text and the mdast node it stands for cannot
 * drift apart.
 */
export class VerbatimNode extends TextNode {
	private readonly __mdast: VerbatimMdast;

	constructor(mdast: VerbatimMdast, key?: NodeKey) {
		super(verbatimText(mdast), key);
		this.__mdast = mdast;
		this.setMode("token");
	}

	static override getType(): string {
		return VERBATIM_TYPE;
	}

	static override clone(node: VerbatimNode): VerbatimNode {
		return new VerbatimNode(node.__mdast, node.__key);
	}

	/** The mdast node to write back out. A copy, so callers cannot change it. */
	getMdast(): VerbatimMdast {
		return { ...this.getLatest().__mdast };
	}

	override createDOM(config: EditorConfig): HTMLElement {
		// TextNode sets the text with the DOM's own text APIs, so the source
		// is displayed, not parsed.
		const dom = super.createDOM(config);
		dom.classList.add("pk-verbatim");
		return dom;
	}

	static override importJSON(
		serialized: SerializedTextNode & { mdast: VerbatimMdast },
	): VerbatimNode {
		return $createVerbatimNode(serialized.mdast);
	}

	override exportJSON(): SerializedTextNode & { mdast: VerbatimMdast } {
		return { ...super.exportJSON(), type: VERBATIM_TYPE, mdast: this.getMdast() };
	}
}

export function $createVerbatimNode(mdast: VerbatimMdast): VerbatimNode {
	return $applyNodeReplacement(new VerbatimNode(mdast));
}

export function $isVerbatimNode(
	node: LexicalNode | null | undefined,
): node is VerbatimNode {
	return node instanceof VerbatimNode;
}

/** True for the syntax-tree nodes the rich view shows as source. */
export function isVerbatim(node: { type: string; url?: string | null }): boolean {
	if (node.type === "html") return true;
	if (node.type !== "image") return false;
	return !isSafeImageSrc(node.url ?? "");
}

/**
 * Claims those nodes before any other visitor. The priority matters: the
 * image plugin ships an HTML-image visitor that builds a DOM element out of
 * the raw HTML with `innerHTML`, and this keeps that code unreachable.
 */
const VERBATIM_PRIORITY = 100;

const importVisitor: MdastImportVisitor<VerbatimMdast> = {
	priority: VERBATIM_PRIORITY,
	testNode: isVerbatim,
	visitNode({ mdastNode, lexicalParent }) {
		if (!$isElementNode(lexicalParent)) return;
		const node = $createVerbatimNode(mdastNode);
		// Only elements may sit directly under the root, so a block-level
		// construct gets a paragraph of its own.
		if (lexicalParent.getType() === "root") {
			const paragraph = $createParagraphNode();
			paragraph.append(node);
			lexicalParent.append(paragraph);
			return;
		}
		lexicalParent.append(node);
	},
};

const exportVisitor: LexicalExportVisitor<VerbatimNode, VerbatimMdast> = {
	priority: VERBATIM_PRIORITY,
	testLexicalNode: $isVerbatimNode,
	visitLexicalNode({ lexicalNode, mdastParent, actions }) {
		actions.appendToParent(mdastParent, lexicalNode.getMdast());
	},
};

export const verbatimPlugin = realmPlugin({
	init(realm) {
		realm.pubIn({
			[addImportVisitor$]: importVisitor,
			[addExportVisitor$]: exportVisitor,
			[addLexicalNode$]: VerbatimNode,
		});
	},
});
