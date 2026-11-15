/**
 * Plain text for a kept check run. The output was written to a terminal, so
 * it carries colour and cursor escapes that mean nothing in a text block.
 */
const ESC = "\u001b";
const BEL = "\u0007";
const ESCAPES = new RegExp(
	`${ESC}\\[[0-?]*[ -/]*[@-~]|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)|${ESC}[@-Z\\\\-_]`,
	"g",
);

/** Output with terminal escapes removed and CRLF line ends made plain. */
export function plainOutput(text: string): string {
	return text.replace(ESCAPES, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** A run's length the way a student reads it: "850 ms", "2.4 s", "3 min 5 s". */
export function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms} ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.round((ms % 60_000) / 1000);
	return seconds === 0 ? `${minutes} min` : `${minutes} min ${seconds} s`;
}
