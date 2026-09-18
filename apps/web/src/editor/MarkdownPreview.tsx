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

export interface MarkdownPreviewProps {
	text: string;
	/** The scrolling element, so the split view can follow the editor. */
	scrollRef?: Ref<HTMLDivElement>;
	onScroll?: UIEventHandler<HTMLDivElement>;
}

export function MarkdownPreview({ text, scrollRef, onScroll }: MarkdownPreviewProps) {
	const { frontmatter, body } = splitFrontmatter(text);
	return (
		<div
			className="pk-markdown"
			data-testid="markdown-preview"
			ref={scrollRef}
			onScroll={onScroll}
		>
			{frontmatter ? (
				<details className="pk-frontmatter" data-testid="markdown-frontmatter">
					<summary>Front matter</summary>
					<pre>{frontmatter}</pre>
				</details>
			) : null}
			<Markdown remarkPlugins={PLUGINS} components={{ a: Link }}>
				{body}
			</Markdown>
		</div>
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
