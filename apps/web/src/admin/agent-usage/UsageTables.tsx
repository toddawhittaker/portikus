import {
	type AgentUsageCounts,
	type AgentUsageResponse,
	AgentUsageWindow,
} from "@portikus/contracts";
import { Select, Toggletip } from "@portikus/ui";
import { useState } from "react";
import { CODING_AGENT_NAME } from "../../agents/codingAgentName.js";
import { cost, count, dayName } from "./format.js";
import { DailyChart, UsageSummary } from "./UsageSummary.js";
import "./usage.css";

const WINDOWS: AgentUsageWindow[] = [7, 30, 90];

/**
 * The period choice above the usage tables. `ready` is true once the tables
 * show the chosen period; a screen reader then hears which period it is.
 */
export function UsagePeriodSelect({
	id,
	days,
	ready,
	onChange,
}: {
	id: string;
	days: AgentUsageWindow;
	ready: boolean;
	onChange: (days: AgentUsageWindow) => void;
}) {
	// Silent on first load; only a change of period is announced.
	const [picked, setPicked] = useState(false);
	return (
		<div className="max-w-48">
			<Select
				id={id}
				label="Period"
				value={String(days)}
				options={WINDOWS.map((w) => ({ value: String(w), label: `Last ${w} days` }))}
				onValueChange={(value) => {
					setPicked(true);
					onChange(AgentUsageWindow.parse(Number(value)));
				}}
			/>
			<span className="sr-only" role="status" data-testid={`${id}-status`}>
				{picked && ready ? `Showing the last ${days} days.` : ""}
			</span>
		</div>
	);
}

const COST_HELP =
	"An estimate at the agent's published API prices, not what a subscription pays. Only Claude Code reports it; Codex shows a dash.";

const CACHE_HELP =
	"Tokens read from and written to the prompt cache, added together. Cached tokens cost far less than new input.";

function CountHeaders() {
	return (
		<>
			<th scope="col" className="pk-num">
				Sessions
			</th>
			<th scope="col" className="pk-num">
				Input tokens
			</th>
			<th scope="col" className="pk-num">
				Output tokens
			</th>
			<th scope="col" className="pk-num">
				<span className="inline-flex items-center gap-1">
					Cache tokens
					<Toggletip label="Cache tokens">{CACHE_HELP}</Toggletip>
				</span>
			</th>
			<th scope="col" className="pk-num">
				<span className="inline-flex items-center gap-1">
					Estimated API cost
					<Toggletip label="Estimated API cost">{COST_HELP}</Toggletip>
				</span>
			</th>
			<th scope="col" className="pk-num">
				Lines
			</th>
		</>
	);
}

/**
 * The row's figures. `share` is the row's cost as a part of the largest
 * cost in the table, drawn as a short bar beside it so the biggest spenders
 * show without reading every figure.
 */
function CountCells({ row, share }: { row: AgentUsageCounts; share?: number }) {
	return (
		<>
			<td className="pk-num" data-label="Sessions">
				{count(row.sessions)}
			</td>
			<td className="pk-num" data-label="Input">
				{count(row.inputTokens)}
			</td>
			<td className="pk-num" data-label="Output">
				{count(row.outputTokens)}
			</td>
			<td className="pk-num" data-label="Cache">
				{count(row.cacheReadTokens + row.cacheWriteTokens)}
			</td>
			<td className="pk-num pk-usage-cost" data-label="Estimated API cost">
				<span className="pk-usage-cost-figure">
					{share !== undefined && row.costUsd !== null ? (
						<span className="pk-usage-share" aria-hidden={true}>
							<span style={{ inlineSize: `${Math.round(share * 100)}%` }} />
						</span>
					) : null}
					{cost(row.costUsd)}
				</span>
			</td>
			<td className="pk-num" data-label="Lines">
				<span className="pk-usage-lines">
					<span className="text-status-running">
						<span className="sr-only">added </span>+{count(row.linesAdded)}
					</span>
					<span className="text-status-error">
						<span className="sr-only">removed </span>−{count(row.linesRemoved)}
					</span>
				</span>
			</td>
		</>
	);
}

/*
 * Both tables share one fixed column plan, so each column of the daily table
 * sits under its counterpart in the per-person table. The first column takes
 * the space left over; the minimum width is the fixed columns plus 12rem for
 * it, and the wrapper scrolls sideways below that until the phone layout
 * stacks each row.
 */
const TABLE_CLASS = "pk-table pk-usage-table table-fixed min-w-[63rem]";

function UsageColumns() {
	return (
		<colgroup>
			<col />
			<col className="w-28" />
			<col className="w-24" />
			<col className="w-28" />
			<col className="w-28" />
			<col className="w-28" />
			<col className="w-44" />
			<col className="w-32" />
		</colgroup>
	);
}

/** The first column wraps, so a long name stays inside its own column. */
const LEAD_CELL_CLASS = "font-normal whitespace-normal wrap-anywhere py-1";

/** The per-person and daily usage tables, shared by the admin tab and the Course page. */
export function UsageTables({ data }: { data: AgentUsageResponse }) {
	const topCost = Math.max(0, ...data.users.map((row) => row.costUsd ?? 0));
	return (
		<>
			<UsageSummary data={data} />
			<DailyChart data={data} />
			<div className="pk-usage-wrap">
				<div className="pk-table-wrap overflow-x-auto">
					<table className={TABLE_CLASS} data-testid="agent-usage-users">
						<caption className="sr-only">
							Agent usage per person, {data.from} to {data.to}
						</caption>
						<UsageColumns />
						<thead>
							<tr>
								<th scope="col">Person</th>
								<th scope="col">Agent</th>
								<CountHeaders />
							</tr>
						</thead>
						<tbody>
							{data.users.map((row) => (
								<tr key={`${row.userId}-${row.agent}`}>
									<th scope="row" className={LEAD_CELL_CLASS}>
										{row.displayName}
									</th>
									<td className="pk-usage-agent" data-agent={row.agent}>
										{CODING_AGENT_NAME[row.agent]}
									</td>
									<CountCells
										row={row}
										share={topCost > 0 ? (row.costUsd ?? 0) / topCost : undefined}
									/>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</div>
			<h3 className="pk-text-heading m-0">Daily totals</h3>
			<div className="pk-usage-wrap">
				<div className="pk-table-wrap overflow-x-auto">
					<table className={TABLE_CLASS} data-testid="agent-usage-daily">
						<caption className="sr-only">
							Agent usage per day for everyone, {data.from} to {data.to}
						</caption>
						<UsageColumns />
						<thead>
							<tr>
								<th scope="col">Day</th>
								<th scope="col">Agent</th>
								<CountHeaders />
							</tr>
						</thead>
						<tbody>
							{data.daily.map((row) => (
								<tr key={`${row.day}-${row.agent}`}>
									<th scope="row" className={LEAD_CELL_CLASS}>
										<time dateTime={row.day}>{dayName(row.day)}</time>
									</th>
									<td className="pk-usage-agent" data-agent={row.agent}>
										{CODING_AGENT_NAME[row.agent]}
									</td>
									<CountCells row={row} />
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</div>
		</>
	);
}
