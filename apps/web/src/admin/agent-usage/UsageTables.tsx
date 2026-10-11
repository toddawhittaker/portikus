import {
	type AgentUsageCounts,
	type AgentUsageResponse,
	AgentUsageWindow,
} from "@portikus/contracts";
import { Select, Toggletip } from "@portikus/ui";
import { useState } from "react";
import { CODING_AGENT_NAME } from "../image/codingAgents.js";
import { cost, count } from "./format.js";

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
				Cache read tokens
			</th>
			<th scope="col" className="pk-num">
				Cache write tokens
			</th>
			<th scope="col" className="pk-num">
				<span className="inline-flex items-center gap-1">
					Estimated API cost
					<Toggletip label="Estimated API cost">{COST_HELP}</Toggletip>
				</span>
			</th>
			<th scope="col" className="pk-num">
				Lines added
			</th>
			<th scope="col" className="pk-num">
				Lines removed
			</th>
		</>
	);
}

function CountCells({ row }: { row: AgentUsageCounts }) {
	return (
		<>
			<td className="pk-num">{count(row.sessions)}</td>
			<td className="pk-num">{count(row.inputTokens)}</td>
			<td className="pk-num">{count(row.outputTokens)}</td>
			<td className="pk-num">{count(row.cacheReadTokens)}</td>
			<td className="pk-num">{count(row.cacheWriteTokens)}</td>
			<td className="pk-num">{cost(row.costUsd)}</td>
			<td className="pk-num">{count(row.linesAdded)}</td>
			<td className="pk-num">{count(row.linesRemoved)}</td>
		</>
	);
}

/** The per-person and daily usage tables, shared by the admin tab and the Course page. */
export function UsageTables({ data }: { data: AgentUsageResponse }) {
	return (
		<>
			<div className="pk-table-wrap overflow-x-auto">
				<table className="pk-table" data-testid="agent-usage-users">
					<caption className="sr-only">
						Agent usage per person, {data.from} to {data.to}
					</caption>
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
								<th scope="row" className="font-normal">
									{row.displayName}
								</th>
								<td>{CODING_AGENT_NAME[row.agent]}</td>
								<CountCells row={row} />
							</tr>
						))}
					</tbody>
				</table>
			</div>
			<h3 className="pk-text-heading m-0">Daily totals</h3>
			<div className="pk-table-wrap overflow-x-auto">
				<table className="pk-table" data-testid="agent-usage-daily">
					<caption className="sr-only">
						Agent usage per day for everyone, {data.from} to {data.to}
					</caption>
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
								<th scope="row" className="font-normal">
									{row.day}
								</th>
								<td>{CODING_AGENT_NAME[row.agent]}</td>
								<CountCells row={row} />
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</>
	);
}
