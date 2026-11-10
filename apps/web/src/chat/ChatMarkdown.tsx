/**
 * Assistant Markdown is untrusted: a prompt-injected image link could leak
 * data to any host (SPEC.md §24.3). Raw HTML is shown as text (no
 * `rehype-raw`), and only http and https links survive, opening in a new
 * tab. Every image goes through `ChatImage`: it is drawn only from the
 * student's own files, through the owner-only image route (SPEC.md §24.1);
 * a remote or data: image is named, never loaded. The rules work on the
 * parsed document, so code keeps the text as written.
 */
import { ChatImagePath, chatImageType } from "@portikus/contracts";
import { type ComponentPropsWithoutRef, memo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "../editor/markdown.css";
import { isSafeLink } from "../markdown/sanitize.js";
import { HighlightedCode } from "./CodeBlocks.js";
import { CopyButton } from "./CopyButton.js";
import { fenceTag, languageFor } from "./highlight.js";
import { useChatImages } from "./ImageViewer.js";

const PLUGINS = [remarkGfm];

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

/** An image's target goes to `ChatImage` as written, which alone decides what loads. */
function chatUrlFor(url: string, key: string): string {
	return key === "src" ? url : chatUrl(url);
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
			aria-label={`View image ${label}`}
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

interface HastNode {
	type?: string;
	tagName?: string;
	value?: string;
	properties?: { className?: unknown };
	children?: HastNode[];
}

function hastText(node: HastNode): string {
	return node.value ?? (node.children ?? []).map(hastText).join("");
}

/**
 * A fenced block's tag and code, read from the parsed document. A tag is
 * named above the block as written; it is coloured only when it is a
 * language we know (`highlight.ts`).
 */
function fence(node: HastNode | undefined): { tag?: string; code: string } | null {
	const code = node?.children?.find((child) => child.tagName === "code");
	if (
		!code ||
		node?.children?.some((child) => child.type === "element" && child !== code)
	) {
		return null;
	}
	return {
		tag: fenceTag(code.properties?.className),
		code: hastText(code).replace(/\n$/, ""),
	};
}

/** A wide code block scrolls, so it must be reachable by keyboard. */
function Pre({
	node,
	children,
	...props
}: ComponentPropsWithoutRef<"pre"> & { node?: unknown }) {
	const pre = useRef<HTMLPreElement | null>(null);
	const block = fence(node as HastNode | undefined);
	const language = languageFor(block?.tag);
	return (
		<div className="pk-chat-pre pk-chat-copy-host">
			{block?.tag ? (
				<span className="pk-chat-lang">{language?.label ?? block.tag}</span>
			) : null}
			{/* biome-ignore lint/a11y/noNoninteractiveTabindex: see above */}
			<pre {...props} ref={pre} tabIndex={0} className="pk-chat-hl">
				{block && language ? (
					<code className={`language-${block.tag}`}>
						<HighlightedCode code={`${block.code}\n`} language={language} />
					</code>
				) : (
					children
				)}
			</pre>
			<CopyButton label="Copy code" text={() => codeText(pre.current)} />
		</div>
	);
}

function Image({ src, alt }: ComponentPropsWithoutRef<"img"> & { node?: unknown }) {
	return <ChatImage target={typeof src === "string" ? src : ""} alt={alt ?? ""} />;
}

const COMPONENTS = { a: Link, img: Image, pre: Pre };

export const ChatMarkdown = memo(function ChatMarkdown({ text }: { text: string }) {
	return (
		<div className="pk-markdown pk-chat-md">
			<Markdown
				remarkPlugins={PLUGINS}
				urlTransform={chatUrlFor}
				components={COMPONENTS}
			>
				{text}
			</Markdown>
		</div>
	);
});
