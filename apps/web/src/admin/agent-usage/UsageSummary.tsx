import type { AgentUsageCounts, AgentUsageResponse } from "@portikus/contracts";
import { CODING_AGENT_NAME } from "../../agents/codingAgentName.js";
import { compact, cost, count, dayName } from "./format.js";

type Agent = AgentUsageResponse["daily"][number]["agent"];

const AGENTS: readonly Agent[] = ["claude", "codex"];

/** Every row's counts added up; the cost only from rows that report one. */
export function usageTotals(rows: readonly AgentUsageCounts[]) {
	let costUsd: number | null = null;
	const totals = {
		sessions: 0,
		inputTokens: 0,
		outputTokens: 0,
		linesAdded: 0,
		linesRemoved: 0,
	};
	for (const row of rows) {
		totals.sessions += row.sessions;
		totals.inputTokens += row.inputTokens;
		totals.outputTokens += row.outputTokens;
		totals.linesAdded += row.linesAdded;
		totals.linesRemoved += row.linesRemoved;
		if (row.costUsd !== null) costUsd = (costUsd ?? 0) + row.costUsd;
	}
	return { ...totals, costUsd };
}

/** The period's totals as four readings, the figures first. */
export function UsageSummary({ data }: { data: AgentUsageResponse }) {
	const totals = usageTotals(data.users);
	const people = new Set(data.users.map((row) => row.userId)).size;
	return (
		<dl className="pk-stats" data-testid="agent-usage-summary">
			<div className="pk-stat">
				<dt className="pk-stat-label">Sessions</dt>
				<dd className="pk-stat-value">{count(totals.sessions)}</dd>
				<dd className="pk-stat-foot">
					{people} {people === 1 ? "person" : "people"}
				</dd>
			</div>
			<div className="pk-stat">
				<dt className="pk-stat-label">Tokens in and out</dt>
				<dd className="pk-stat-value">
					{compact(totals.inputTokens)}
					<span className="pk-stat-of"> in</span> {compact(totals.outputTokens)}
					<span className="pk-stat-of"> out</span>
				</dd>
				<dd className="pk-stat-foot">Cache tokens not counted</dd>
			</div>
			<div className="pk-stat">
				<dt className="pk-stat-label">Estimated API cost</dt>
				<dd className="pk-stat-value">{cost(totals.costUsd)}</dd>
				<dd className="pk-stat-foot">Claude Code only; Codex reports no cost</dd>
			</div>
			<div className="pk-stat">
				<dt className="pk-stat-label">Lines changed</dt>
				<dd className="pk-stat-value pk-usage-lines-figure">
					<span className="text-status-running">
						<span className="sr-only">added </span>+{compact(totals.linesAdded)}
					</span>{" "}
					<span className="text-status-error">
						<span className="sr-only">removed </span>−{compact(totals.linesRemoved)}
					</span>
				</dd>
				<dd className="pk-stat-foot">As the agents report them</dd>
			</div>
		</dl>
	);
}

/** Each day from `from` to `to`, inclusive, as YYYY-MM-DD. */
export function daysBetween(from: string, to: string): string[] {
	const days: string[] = [];
	const at = new Date(`${from}T00:00:00Z`);
	const end = new Date(`${to}T00:00:00Z`);
	while (at <= end && days.length < 400) {
		days.push(at.toISOString().slice(0, 10));
		at.setUTCDate(at.getUTCDate() + 1);
	}
	return days;
}

/**
 * Tokens per day as stacked bars, one colour an agent. A picture of the
 * daily table that follows, which holds every figure, so the bars are hidden
 * from screen readers.
 */
export function DailyChart({ data }: { data: AgentUsageResponse }) {
	const days = daysBetween(data.from, data.to);
	const tokens = new Map<string, number>();
	for (const row of data.daily) {
		const key = `${row.day}:${row.agent}`;
		tokens.set(key, (tokens.get(key) ?? 0) + row.inputTokens + row.outputTokens);
	}
	const totalOf = (day: string) =>
		AGENTS.reduce((sum, agent) => sum + (tokens.get(`${day}:${agent}`) ?? 0), 0);
	const most = Math.max(1, ...days.map(totalOf));
	// About ten labels however long the period, so they never crowd.
	const every = Math.max(1, Math.ceil(days.length / 10));
	return (
		<figure className="pk-usage-chart" data-testid="agent-usage-chart">
			<figcaption className="pk-usage-chart-head">
				<span className="pk-text-heading">Tokens per day</span>
				<span className="pk-usage-legend">
					{AGENTS.map((agent) => (
						<span key={agent} className="pk-usage-key" data-agent={agent}>
							<span className="pk-usage-swatch" aria-hidden={true} />
							{CODING_AGENT_NAME[agent]}
						</span>
					))}
				</span>
			</figcaption>
			<div className="pk-usage-bars" aria-hidden={true}>
				{days.map((day, index) => {
					const total = totalOf(day);
					return (
						<div
							key={day}
							className="pk-usage-day"
							title={`${dayName(day)}: ${count(total)} tokens`}
						>
							<div className="pk-usage-stack">
								{AGENTS.map((agent) => {
									const value = tokens.get(`${day}:${agent}`) ?? 0;
									if (value === 0) return null;
									return (
										<span
											key={agent}
											className="pk-usage-seg"
											data-agent={agent}
											style={{ blockSize: `${(value / most) * 100}%` }}
										/>
									);
								})}
							</div>
							<span className="pk-usage-tick">
								{index % every === 0 ? dayName(day, true) : ""}
							</span>
						</div>
					);
				})}
			</div>
		</figure>
	);
}
