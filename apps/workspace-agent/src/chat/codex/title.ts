const MAX_TITLE_CHARS = 200;

/** A row or card title, cut to what one line shows. */
export function shortTitle(text: string): string {
	return text.length > MAX_TITLE_CHARS
		? `${text.slice(0, MAX_TITLE_CHARS - 1)}…`
		: text;
}
