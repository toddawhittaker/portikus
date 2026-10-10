/** "23 Sep 2026, 14:05" in the browser's own locale and zone, or a dash when there is no time. */
export function dateTimeText(iso: string | null): string {
	if (iso === null) return "—";
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "—";
	return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
