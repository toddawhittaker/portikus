/**
 * A message that starts with `!` is a shell command, not a prompt (SPEC.md
 * §10.8). A lone `!` is not one: there is nothing to run.
 */

/** The text after the leading `!`, without the space around it. */
export function shellCommandText(text: string): string {
	const trimmed = text.trimStart();
	return (trimmed.startsWith("!") ? trimmed.slice(1) : trimmed).trim();
}

export function isShellCommand(text: string): boolean {
	return text.trimStart().startsWith("!") && shellCommandText(text) !== "";
}
