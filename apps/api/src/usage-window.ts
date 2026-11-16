import type { AgentUsageWindow } from "@portikus/contracts";

const DAY_MS = 86_400_000;

/** The window's first and last UTC day, inclusive, ending today. */
export function windowDays(
	days: AgentUsageWindow,
	now: Date,
): { from: string; to: string } {
	const to = now.toISOString().slice(0, 10);
	const from = new Date(now.getTime() - (days - 1) * DAY_MS).toISOString().slice(0, 10);
	return { from, to };
}
