import { UUID } from "./links.js";

/** Small wording helpers shared across the app, so the same thing reads the same way everywhere. */

/** "Just now", "4 minutes ago", "3 hours ago", "2 days ago"; an em dash when there is no time. */
export function timeAgo(iso: string | null | undefined, now: number): string {
	if (!iso) return "—";
	const minutes = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
	if (minutes < 1) return "Just now";
	if (minutes < 60) return `${plural(minutes, "minute")} ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${plural(hours, "hour")} ago`;
	return `${plural(Math.floor(hours / 24), "day")} ago`;
}

/** "24 hours left", "40 minutes left"; "Ended" once the time has passed. */
export function timeLeft(iso: string, now: number): string {
	const minutes = Math.floor((Date.parse(iso) - now) / 60_000);
	if (minutes < 0) return "Ended";
	if (minutes < 1) return "Less than a minute left";
	if (minutes < 60) return `${plural(minutes, "minute")} left`;
	return `${plural(Math.round(minutes / 60), "hour")} left`;
}

/** A short date and time, such as "Sep 26, 10:00" (SPEC.md section 20.1). */
export function shortTime(iso: string): string {
	return new Date(iso).toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

/** "1 host", "3 hosts"; pass `many` when adding an "s" is wrong. */
export function plural(count: number, one: string, many = `${one}s`): string {
	return `${count} ${count === 1 ? one : many}`;
}

/** "A", "A and B", "A, B and C"; `or` for a choice. */
export function joinWords(
	words: readonly string[],
	conjunction: "and" | "or" = "and",
): string {
	if (words.length <= 1) return words[0] ?? "";
	return `${words.slice(0, -1).join(", ")} ${conjunction} ${words[words.length - 1]}`;
}

/** The first 8 characters of a UUID, keeping a `user:` style prefix. */
export function shortId(value: string): string {
	const colon = value.indexOf(":");
	const prefix = colon === -1 ? "" : value.slice(0, colon + 1);
	const rest = value.slice(prefix.length);
	return UUID.test(rest) ? `${prefix}${rest.slice(0, 8)}` : value;
}
