const NUMBER = new Intl.NumberFormat("en-US");
const COMPACT = new Intl.NumberFormat("en-US", {
	notation: "compact",
	maximumFractionDigits: 1,
});
const MONEY = new Intl.NumberFormat("en-US", {
	style: "currency",
	currency: "USD",
});

export function count(value: number): string {
	return NUMBER.format(value);
}

/** "1.9M", "12.5K": a total read at a glance; the tables keep the exact figure. */
export function compact(value: number): string {
	return COMPACT.format(value);
}

/** Codex reports no cost, so a missing one reads as a dash. */
export function cost(value: number | null): string {
	return value === null ? "—" : MONEY.format(value);
}

/** "Thu, Nov 6" for a usage day (YYYY-MM-DD, UTC); `short` gives "Thu 6" for a chart axis. */
export function dayName(day: string, short = false): string {
	const at = new Date(`${day}T00:00:00Z`);
	if (Number.isNaN(at.getTime())) return day;
	if (short) {
		const weekday = at.toLocaleDateString("en-US", {
			weekday: "short",
			timeZone: "UTC",
		});
		return `${weekday} ${at.getUTCDate()}`;
	}
	return at.toLocaleDateString("en-US", {
		weekday: "short",
		month: "short",
		day: "numeric",
		timeZone: "UTC",
	});
}
