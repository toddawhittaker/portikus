import type {
	AgentLimitWindow,
	AgentMeter,
	AgentUsageCounts,
	CodingAgent,
} from "@portikus/contracts";
import { CODING_AGENT_NAME } from "../admin/image/codingAgents.js";
import { METER_CLEAR_BELOW, METER_WARN_AT } from "../shell/meterLevel.js";

export const AGENT_NAMES: Record<CodingAgent, string> = CODING_AGENT_NAME;

/** What the status bar shows for one agent. */
export type AgentDisplay =
	| { kind: "limits"; windows: AgentLimitWindow[]; top: AgentLimitWindow }
	| { kind: "today"; counts: AgentUsageCounts }
	| null;

/** Windows that have not yet reset; a past reset means the figure is stale. */
export function liveWindows(
	windows: readonly AgentLimitWindow[],
	now: number,
): AgentLimitWindow[] {
	return windows.filter((window) => Date.parse(window.resetsAt) > now);
}

/** Input and output tokens; cache tokens are listed apart in the details. */
function tokenTotal(counts: AgentUsageCounts): number {
	return counts.inputTokens + counts.outputTokens;
}

/** Limits first; else today's counts when there are any; else nothing. */
export function chooseDisplay(
	entry: AgentMeter["agents"][number],
	now: number,
): AgentDisplay {
	const windows = entry.limits ? liveWindows(entry.limits.windows, now) : [];
	const [first, ...rest] = windows;
	if (first) {
		const top = rest.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a), first);
		return { kind: "limits", windows, top };
	}
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

export const warnKey = (agent: CodingAgent, window: AgentLimitWindow) =>
	`${agent}|${window.name}|${window.resetsAt}`;

/** The windows at the warning threshold that have not been warned about yet. */
export function windowsToWarn(
	agent: CodingAgent,
	windows: readonly AgentLimitWindow[],
	seen: ReadonlySet<string>,
): AgentLimitWindow[] {
	return windows.filter(
		(window) =>
			limitWarning(window.usedPercent, false) && !seen.has(warnKey(agent, window)),
	);
}
