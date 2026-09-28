/**
 * The disconnect grace period in words, for the helper text under an input
 * (SPEC.md §6.4). Zero means the workspace keeps running.
 */
export function graceText(seconds: number): string {
	if (seconds === 0) return "Workspaces keep running until stopped by hand";
	return graceLength(seconds);
}

/** A non-zero grace period as hours, minutes and seconds. */
function graceLength(seconds: number): string {
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const rest = seconds % 60;
	const parts: string[] = [];
	if (hours > 0) parts.push(plural(hours, "hour"));
	if (minutes > 0) parts.push(plural(minutes, "minute"));
	if (rest > 0) parts.push(plural(rest, "second"));
	return parts.join(" ");
}

function plural(count: number, unit: string): string {
	return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

/** The largest grace period the API's 32-bit integer column takes. */
const MAX_GRACE_SECONDS = 2147483647;

/**
 * Seconds as the minutes the Settings tab shows: whole where they can be,
 * else to two places, so an odd stored value such as 90 seconds reads "1.5".
 */
export function graceMinutes(seconds: number): string {
	return String(Math.round((seconds / 60) * 100) / 100);
}

/** Reads a minutes entry as whole seconds, or null when it is not a number at or above 0. */
export function parseGraceMinutes(text: string): number | null {
	const trimmed = text.trim();
	if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
	const seconds = Math.round(Number(trimmed) * 60);
	return seconds > MAX_GRACE_SECONDS ? null : seconds;
}
