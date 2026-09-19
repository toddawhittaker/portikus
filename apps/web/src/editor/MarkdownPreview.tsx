/**
 * The rendered view of a Markdown file (SPEC.md §13.4). Frontmatter is shown
 * as a collapsed block of raw text above the body, so it can never be read as
 * Markdown. Raw HTML in the file is deliberately not rendered: react-markdown
 * escapes it without `rehype-raw`, so a student's `<script>` line shows as
 * text (SPEC.md §24, student content is untrusted).
 */
import type { ComponentPropsWithoutRef, Ref, UIEventHandler } from "react";
import Markdown from "react-markdown";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import { splitFrontmatter } from "./frontmatter.js";
import "./markdown.css";

// remark-frontmatter catches the blocks splitFrontmatter does not match, such
// as a file that starts with a byte order mark, so they never render as
// Markdown headings.
const PLUGINS = [remarkGfm, remarkFrontmatter];

/** The block elements that carry a source line for the scroll sync. */
const BLOCKS = new Set([
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"p",
	"li",
	"pre",
	"table",
	"blockquote",
	"hr",
]);

/** Only the parts of a hast tree this plugin touches. */
interface HastNode {
	type?: string;
	tagName?: string;
	properties?: Record<string, unknown>;
	position?: { start?: { line?: number } };
	children?: HastNode[];
}

/**
 * Marks every rendered block with the source line it came from, so the split
 * view can put the same line at the top of both sides (SPEC.md §13.4). The
 * offset puts back the frontmatter lines that were cut off the body before
 * parsing, so the numbers are lines of the file the editor holds.
 */
function rehypeSourceLines(offset: number) {
	return (tree: HastNode) => mark(tree, offset);
}

function mark(node: HastNode, offset: number): void {
	for (const child of node.children ?? []) {
		const line = child.position?.start?.line;
		if (child.type === "element" && BLOCKS.has(child.tagName ?? "") && line) {
			child.properties = { ...child.properties, "data-line": line + offset };
		}
		mark(child, offset);
	}
}

export interface MarkdownPreviewProps {
	text: string;
	/** The scrolling element, so the split view can follow the editor. */
	scrollRef?: Ref<HTMLDivElement>;
	onScroll?: UIEventHandler<HTMLDivElement>;
}

export function MarkdownPreview({ text, scrollRef, onScroll }: MarkdownPreviewProps) {
	const { frontmatter, body } = splitFrontmatter(text);
	// The two fence lines plus the frontmatter's own lines were cut off the
	// body, and the body starts on the line after the closing fence.
	const offset = frontmatter === null ? 0 : countLines(frontmatter) + 2;
	return (
		<div
			className="pk-markdown"
			data-testid="markdown-preview"
			ref={scrollRef}
			onScroll={onScroll}
		>
			{frontmatter ? (
				<details
					className="pk-frontmatter"
					data-testid="markdown-frontmatter"
					data-line={1}
				>
					<summary>Front matter</summary>
					<pre>{frontmatter}</pre>
				</details>
			) : null}
			<Markdown
				remarkPlugins={PLUGINS}
				rehypePlugins={[[rehypeSourceLines, offset]]}
				components={{ a: Link }}
			>
				{body}
			</Markdown>
		</div>
	);
}

/** How many lines of text a frontmatter block holds; empty is none. */
function countLines(frontmatter: string): number {
	return frontmatter === "" ? 0 : frontmatter.split("\n").length;
}

/** Only a real web link leaves the workspace UI, so only it gets a new tab. */
function Link({
	node: _node,
	children,
	href,
	...props
}: ComponentPropsWithoutRef<"a"> & { node?: unknown }) {
	const external = href !== undefined && /^https?:\/\//i.test(href);
	if (!external) {
		return (
			<a {...props} href={href}>
				{children}
			</a>
		);
	}
	return (
		<a {...props} href={href} target="_blank" rel="noopener noreferrer">
			{children}
		</a>
	);
}
