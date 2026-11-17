import type { ReactNode } from "react";

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

/** A dash for sighted readers, with the words a screen reader skips a bare dash without. */
function dash(meaning: string): ReactNode {
	return (
		<>
			<span aria-hidden="true">—</span>
			<span className="sr-only">{meaning}</span>
		</>
	);
}

/** Codex reports no cost, so a missing one reads as a dash that a screen reader announces as "no cost". */
export function cost(value: number | null): ReactNode {
	return value === null ? dash("no cost") : MONEY.format(value);
}

/** A priced estimate as text: "under $0.01" rather than a false zero. */
export function estimateText(value: number): string {
	if (value > 0 && value < 0.005) return "under $0.01";
	return MONEY.format(value);
}

/** An estimated dollar figure for a table cell: a dash announced as "no estimate" when it could not be priced. */
export function estimate(value: number | null): ReactNode {
	return value === null ? dash("no estimate") : estimateText(value);
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
