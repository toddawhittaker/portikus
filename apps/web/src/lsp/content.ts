/**
 * Hover and completion text is untrusted: it can come from a docstring in a
 * file the student copied (SPEC.md §13.6, §24.3). It is shown as Markdown
 * that is never trusted and never HTML, with only http(s) links and no images.
 */
import type * as Monaco from "monaco-editor";
import type { MarkedString, MarkupContent } from "vscode-languageserver-protocol";
import { sanitizeMarkdown } from "../markdown/sanitize.js";

function escapeMarkdown(text: string): string {
	return text.replace(/[\\`*_{}[\]()#+\-.!<>|~]/g, "\\$&");
}

function fence(language: string, value: string): string {
	const name = language.replace(/[^\w+-]/g, "");
	return `\`\`\`${name}\n${value.replace(/```/g, "` ` `")}\n\`\`\``;
}

function untrusted(value: string): Monaco.IMarkdownString {
	return { value, isTrusted: false, supportHtml: false, supportThemeIcons: false };
}

/** Any LSP hover or documentation content as untrusted Monaco Markdown. */
export function toMarkdown(
	content: MarkupContent | MarkedString | MarkedString[] | string,
): Monaco.IMarkdownString[] {
	const parts = Array.isArray(content) ? content : [content];
	return parts
		.map((part) => {
			if (typeof part === "string") return sanitizeMarkdown(part);
			if ("kind" in part) {
				return part.kind === "markdown"
					? sanitizeMarkdown(part.value)
					: escapeMarkdown(part.value);
			}
			return fence(part.language, part.value);
		})
		.filter((value) => value.trim() !== "")
		.map(untrusted);
}
