/**
 * Assistant Markdown is untrusted: a prompt-injected image link could leak
 * data to any host (SPEC.md §24.3). It goes through `sanitizeMarkdown`, raw
 * HTML is escaped (no `rehype-raw`), images are never drawn, and only http
 * and https links survive, opening in a new tab.
 */
import { type ComponentPropsWithoutRef, memo } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "../editor/markdown.css";
import { isSafeLink, sanitizeMarkdown } from "../markdown/sanitize.js";

const PLUGINS = [remarkGfm];
const NO_IMAGES = ["img"];

/** Anything but an http(s) address is dropped, whatever attribute holds it. */
export function chatUrl(url: string): string {
	return isSafeLink(url) ? url : "";
}

function Link({
	node: _node,
	href,
	children,
	...props
}: ComponentPropsWithoutRef<"a"> & { node?: unknown }) {
	if (!href) return <span>{children}</span>;
	return (
		<a {...props} href={href} target="_blank" rel="noopener noreferrer">
			{children}
		</a>
	);
}

/** A wide code block scrolls, so it must be reachable by keyboard. */
function Pre({
	node: _node,
	...props
}: ComponentPropsWithoutRef<"pre"> & { node?: unknown }) {
	// biome-ignore lint/a11y/noNoninteractiveTabindex: see above
	return <pre {...props} tabIndex={0} />;
}

const COMPONENTS = { a: Link, pre: Pre };

export const ChatMarkdown = memo(function ChatMarkdown({ text }: { text: string }) {
	return (
		<div className="pk-markdown pk-chat-md">
			<Markdown
				remarkPlugins={PLUGINS}
				urlTransform={chatUrl}
				disallowedElements={NO_IMAGES}
				components={COMPONENTS}
			>
				{sanitizeMarkdown(text)}
			</Markdown>
		</div>
	);
});
