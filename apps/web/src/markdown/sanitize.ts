/**
 * Untrusted Markdown, such as hover text or an agent's reply, is shown with
 * no images and only http(s) links, so it cannot load from or link to
 * anything else (SPEC.md §24.3).
 */

const SAFE_LINK = /^https?:\/\//i;

/** Whether a link target may be kept: http and https only. */
export function isSafeLink(url: string): boolean {
	return SAFE_LINK.test(url);
}

/** Untrusted Markdown with images removed and only http(s) links kept. */
export function sanitizeMarkdown(markdown: string): string {
	return (
		// An image anywhere loads from any https host the CSP allows. Tags go
		// first, because removing "<img>" from "!<img>[" would make an image.
		// Escaping every "![" goes last, because dropping an unsafe link or
		// autolink leaves its text, which can end in "!" before the next "[".
		// The escape removes every image form, reference ones included, and
		// leaves the alt text readable.
		markdown
			.replace(/<img\b[^>]*>/gi, "")
			// A reference definition whose target is not http(s) is dropped.
			.replace(/^ {0,3}\[[^\]]+\]:\s*(\S+).*$/gm, (line, target: string) =>
				isSafeLink(target.replace(/^<|>$/g, "")) ? line : "",
			)
			// No lookbehind for a backslash: "\\" or "!\\" before the bracket can
			// itself be an escaped backslash, and the link after it is real.
			.replace(
				/\[([^\]]*)\]\(\s*<?([^)\s>]*)>?[^)]*\)/g,
				(link, text: string, target: string) => (isSafeLink(target) ? link : text),
			)
			// Autolinks such as <command:x> or <file:///etc/passwd>.
			.replace(/<([a-z][a-z0-9+.-]*:[^>\s]*)>/gi, (link, target: string) =>
				isSafeLink(target) ? link : target,
			)
			.replaceAll("![", "!\\[")
	);
}
