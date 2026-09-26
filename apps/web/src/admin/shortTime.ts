/** The admin tables' short time, such as "Sep 26, 10:00" (SPEC.md section 20.1). */
export function shortTime(iso: string): string {
	return new Date(iso).toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}
