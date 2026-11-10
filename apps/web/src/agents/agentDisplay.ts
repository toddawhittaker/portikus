import type { AgentMeter, AgentUsageCounts, PlanUsage } from "@portikus/contracts";
import { METER_CLEAR_BELOW, METER_WARN_AT } from "../shell/meterLevel.js";

/** One provider's row of the meter: its plan usage and today's counts. */
export type ProviderMeter = AgentMeter["providers"][number];

/** What the status bar shows for one provider. */
export type AgentDisplay =
	| { kind: "plan"; plan: PlanUsage }
	| { kind: "today"; counts: AgentUsageCounts }
	| null;

/** The plan unless its reset has passed, which means the figure is stale. */
export function livePlan(plan: PlanUsage | null, now: number): PlanUsage | null {
	return plan && Date.parse(plan.resetsAt) > now ? plan : null;
}

/** Input and output tokens; cache tokens are listed apart in the details. */
function tokenTotal(counts: AgentUsageCounts): number {
	return counts.inputTokens + counts.outputTokens;
}

/** The plan figure first; counts only when there is no plan; else nothing. */
export function chooseDisplay(entry: ProviderMeter, now: number): AgentDisplay {
	const plan = livePlan(entry.plan, now);
	if (plan) return { kind: "plan", plan };
	const counts = entry.today;
	if (counts && (counts.sessions > 0 || tokenTotal(counts) > 0)) {
		return { kind: "today", counts };
	}
	return null;
}

const COMPACT = new Intl.NumberFormat("en-US", {
	notation: "compact",
	maximumFractionDigits: 1,
});
const WHOLE = new Intl.NumberFormat("en-US");
const DOLLARS = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

const formatTokens = (count: number) => COMPACT.format(count);
export const formatCount = (count: number) => WHOLE.format(count);
export const formatCost = (usd: number) => `≈${DOLLARS.format(usd)}`;

/** "1.2M tokens · ≈$3.40", with no cost part when the agent reports none. */
export function todayText(counts: AgentUsageCounts): string {
	const tokens = `${formatTokens(tokenTotal(counts))} tokens`;
	return counts.costUsd === null ? tokens : `${tokens} · ${formatCost(counts.costUsd)}`;
}

/** Rounded down, so 84.9 never reads as the 85 where the warning starts. */
export function percentText(usedPercent: number): string {
	return `${Math.floor(usedPercent)}%`;
}

/** Warning from 85%, and once warning until it falls below 80%, as the other meters do. */
export function limitWarning(usedPercent: number, warned: boolean): boolean {
	return usedPercent / 100 >= (warned ? METER_CLEAR_BELOW : METER_WARN_AT);
}

export const warnKey = (plan: PlanUsage) => `${plan.id}|${plan.resetsAt}`;

/** Whether a plan is at the warning share and has not been warned about yet. */
export function shouldWarn(plan: PlanUsage, seen: ReadonlySet<string>): boolean {
	return limitWarning(plan.usedPercent, false) && !seen.has(warnKey(plan));
}
