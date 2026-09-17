/**
 * The disconnect grace period in words, for the helper text under an input
 * (SPEC.md §6.4). Zero means the workspace keeps running.
 */
export function graceText(seconds: number): string {
	if (seconds === 0) return "Workspaces keep running until stopped by hand";
	return graceLength(seconds);
}

/** The placeholder for a user with no override: "Default (10 minutes)". */
export function defaultLabel(globalSeconds: number): string {
	return `Default (${globalSeconds === 0 ? "indefinite" : graceLength(globalSeconds)})`;
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
