/**
 * Assistant Markdown is untrusted: a prompt-injected image link could leak
 * data to any host (SPEC.md §24.3). It goes through `sanitizeMarkdown`, raw
 * HTML is escaped (no `rehype-raw`), and only http and https links survive,
 * opening in a new tab. An image is drawn only from the student's own files,
 * through the owner-only image route (SPEC.md §24.1); a remote or data:
 * image is named, never loaded.
 */
import { ChatImagePath, chatImageType } from "@portikus/contracts";
import { type ComponentPropsWithoutRef, memo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "../editor/markdown.css";
import { isSafeLink, sanitizeMarkdown } from "../markdown/sanitize.js";
import { CopyButton } from "./CopyButton.js";
import { useChatImages } from "./ImageViewer.js";

const PLUGINS = [remarkGfm];
const NO_IMAGES = ["img"];

/**
 * Inline images become links to this reserved, never-resolving address
 * before sanitizing, so the image rules below decide each one instead of
 * the sanitizer dropping it.
 */
const IMAGE_MARK = "https://image.portikus.invalid/";

/** Turn each inline image into a marked link carrying its target and alt text. */
function markImages(markdown: string): string {
	return markdown.replace(
		/!\[([^\]]*)\]\(\s*<?([^)\s>]*)>?[^)]*\)/g,
		(_image, alt: string, target: string) =>
			`[${alt}](${IMAGE_MARK}?${new URLSearchParams({ src: target, alt })})`,
	);
}

export type ImageTarget =
	| { kind: "local"; path: string }
	| { kind: "remote"; host: string }
	| { kind: "missing" };

/** What an image target in a reply may be: a local image path, remote, or nothing showable. */
export function imageTarget(target: string): ImageTarget {
	if (/^https?:\/\//i.test(target)) {
		try {
			return { kind: "remote", host: new URL(target).host };
		} catch {
			return { kind: "missing" };
		}
	}
	if (/^data:/i.test(target)) return { kind: "remote", host: "data URL" };
	let path = target.replace(/^file:\/\//i, "");
	if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return { kind: "missing" };
	try {
		path = decodeURI(path);
	} catch {
		return { kind: "missing" };
	}
	path = path.replace(/^(\.\/)+/, "");
	if (!ChatImagePath.safeParse(path).success || chatImageType(path) === null) {
		return { kind: "missing" };
	}
	return { kind: "local", path };
}

/** Anything but an http(s) address is dropped, whatever attribute holds it. */
export function chatUrl(url: string): string {
	return isSafeLink(url) ? url : "";
}

function ChatImage({ target, alt }: { target: string; alt: string }) {
	const images = useChatImages();
	const [failed, setFailed] = useState(false);
	const parsed = imageTarget(target);
	if (parsed.kind === "remote") {
		return (
			<span className="pk-chat-image-note">Remote image not shown: {parsed.host}</span>
		);
	}
	if (parsed.kind === "missing" || images === null || failed) {
		return <span className="pk-chat-image-note">Image not found: {target}</span>;
	}
	const { path } = parsed;
	const src = images.imageUrl(path);
	const name = path.slice(path.lastIndexOf("/") + 1);
	const label = alt || name;
	return (
		<button
			type="button"
			className="pk-chat-image"
			onClick={() =>
				images.open({
					src,
					name,
					alt: label,
					...(path.startsWith("/") ? {} : { projectPath: path }),
				})
			}
		>
			<img src={src} alt={label} loading="lazy" onError={() => setFailed(true)} />
		</button>
	);
}

function Link({
	node: _node,
	href,
	children,
	...props
}: ComponentPropsWithoutRef<"a"> & { node?: unknown }) {
	if (href?.startsWith(IMAGE_MARK)) {
		const query = new URLSearchParams(href.slice(href.indexOf("?") + 1));
		return <ChatImage target={query.get("src") ?? ""} alt={query.get("alt") ?? ""} />;
	}
	if (!href) return <span>{children}</span>;
	return (
		<a {...props} href={href} target="_blank" rel="noopener noreferrer">
			{children}
		</a>
	);
}

/** The code a block holds, as written: Markdown ends each block with a newline. */
function codeText(pre: HTMLPreElement | null): string {
	return (pre?.textContent ?? "").replace(/\n$/, "");
}

/** A wide code block scrolls, so it must be reachable by keyboard. */
function Pre({
	node: _node,
	...props
}: ComponentPropsWithoutRef<"pre"> & { node?: unknown }) {
	const pre = useRef<HTMLPreElement | null>(null);
	return (
		<div className="pk-chat-pre pk-chat-copy-host">
			{/* biome-ignore lint/a11y/noNoninteractiveTabindex: see above */}
			<pre {...props} ref={pre} tabIndex={0} />
			<CopyButton label="Copy code" text={() => codeText(pre.current)} />
		</div>
	);
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
				{sanitizeMarkdown(markImages(text))}
			</Markdown>
		</div>
	);
});
