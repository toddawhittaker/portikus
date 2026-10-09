/**
 * The rendered view of a Markdown file (SPEC.md §13.4). Frontmatter is shown
 * as a collapsed block of raw text above the body, so it can never be read as
 * Markdown. Raw HTML in the file is deliberately not rendered: react-markdown
 * escapes it without `rehype-raw`, so a student's `<script>` line shows as
 * text (SPEC.md §24, student content is untrusted). Fenced code that names a
 * language is highlighted by Monaco (highlight.ts).
 */
import type { ComponentPropsWithoutRef, Ref, UIEventHandler } from "react";
import Markdown, { defaultUrlTransform, type UrlTransform } from "react-markdown";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import { projectImagePath } from "../files/viewable.js";
import { splitFrontmatter } from "./frontmatter.js";
import { useHighlight } from "./highlight.js";
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
	/** The Markdown file's project path, which relative images resolve against. */
	path?: string;
	/** The address that serves a project file as an image. */
	imageUrl?: (projectPath: string) => string;
}

export function MarkdownPreview({
	text,
	scrollRef,
	onScroll,
	path,
	imageUrl,
}: MarkdownPreviewProps) {
	const { frontmatter, body } = splitFrontmatter(text);
	// The two fence lines plus the frontmatter's own lines were cut off the
	// body, and the body starts on the line after the closing fence.
	const offset = frontmatter === null ? 0 : countLines(frontmatter) + 2;
	// A relative image is a file in this project, so it comes through the
	// file route; any other address keeps react-markdown's own check.
	const urlTransform: UrlTransform = (url, key, node) => {
		if (key === "src" && node.tagName === "img" && path !== undefined && imageUrl) {
			const target = projectImagePath(url, path);
			if (target !== null) return imageUrl(target);
		}
		return defaultUrlTransform(url);
	};
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
				urlTransform={urlTransform}
				components={{ a: Link, input: TaskBox, code: Code }}
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

/**
 * A task list's checkbox. remark-gfm draws it with no label, and the item's
 * text comes after it, so it gets a short name of its own.
 */
function TaskBox({
	node: _node,
	...props
}: ComponentPropsWithoutRef<"input"> & { node?: unknown }) {
	return (
		<input {...props} aria-label={props.type === "checkbox" ? "Task" : undefined} />
	);
}

/**
 * Code in the document. A fenced block that names a language is highlighted
 * by Monaco once it has loaded; until then, and for any language Monaco does
 * not know, it is the same text unstyled, so nothing moves when colour arrives.
 */
function Code({
	node: _node,
	className,
	children,
	...props
}: ComponentPropsWithoutRef<"code"> & { node?: unknown }) {
	const fence = /(?:^|\s)language-(\S+)/.exec(className ?? "")?.[1];
	if (fence === undefined || typeof children !== "string") {
		return (
			<code {...props} className={className}>
				{children}
			</code>
		);
	}
	return <FencedCode className={className} code={children} fence={fence} />;
}

function FencedCode({
	className,
	code,
	fence,
}: {
	className: string | undefined;
	code: string;
	fence: string;
}) {
	// The closing fence leaves a line break the highlighter would draw as a line.
	const text = code.endsWith("\n") ? code.slice(0, -1) : code;
	const runs = useHighlight(text, fence);
	if (runs === null) return <code className={className}>{code}</code>;
	return (
		<code className={className} data-colorized="">
			{runs.map((run, at) =>
				run.className === undefined ? (
					run.text
				) : (
					// Runs are rebuilt whole on every change, so their order is their identity.
					// biome-ignore lint/suspicious/noArrayIndexKey: see above
					<span key={at} className={run.className}>
						{run.text}
					</span>
				),
			)}
			{"\n"}
		</code>
	);
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
