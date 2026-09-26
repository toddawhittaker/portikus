/** The admin tables' short time, such as "Sep 26, 10:00" (EPIC-18 ruling 19). */
export function shortTime(iso: string): string {
	return new Date(iso).toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}
