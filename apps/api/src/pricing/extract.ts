export const PAGE_TEXT_MAX_CHARS = 100_000;

const ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
};

function decodeEntities(text: string): string {
	return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
		if (name.startsWith("#x") || name.startsWith("#X"))
			return String.fromCodePoint(Number.parseInt(name.slice(2), 16) || 32);
		if (name.startsWith("#")) return String.fromCodePoint(Number(name.slice(1)) || 32);
		return ENTITIES[name.toLowerCase()] ?? whole;
	});
}

/**
 * A pricing page as plain text for the model: no scripts, styles or tags,
 * whitespace collapsed, and capped so one page cannot fill the context.
 */
export function pageText(html: string): string {
	const text = html
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, " ")
		.replace(/<[^>]*>/g, " ");
	return decodeEntities(text).replace(/\s+/g, " ").trim().slice(0, PAGE_TEXT_MAX_CHARS);
}
