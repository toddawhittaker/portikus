import {
	type AgentUsageCounts,
	type AgentUsageResponse,
	AgentUsageWindow,
} from "@portikus/contracts";
import { Select, Toggletip } from "@portikus/ui";
import { useState } from "react";
import { ApiError } from "../../api/request.js";
import { AdminSection } from "../AdminSection.js";
import { CODING_AGENT_NAME } from "../image/codingAgents.js";
import { cost, count } from "./format.js";
import { useAgentUsage } from "./queries.js";

const WINDOWS: AgentUsageWindow[] = [7, 30, 90];

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

function UsageTables({ data }: { data: AgentUsageResponse }) {
	return (
		<>
			<div className="pk-table-wrap overflow-clip">
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
			<div className="pk-table-wrap overflow-clip">
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

/** The Agent usage tab of the admin page (SPEC.md section 25.10): everyone's totals, counts only. */
export function AgentUsageTab() {
	const [days, setDays] = useState<AgentUsageWindow>(7);
	const usage = useAgentUsage(days);
	const data = usage.data;
	return (
		<AdminSection
			title="Agent usage"
			intro={{
				id: "admin-agents",
				text: "How much each person has used Claude Code and Codex. Usage counts never include prompts or code. The agents report them from inside the workspace, so treat them as a guide, not proof.",
				helpAnchor: "admin-agents",
			}}
		>
			<div className="max-w-48">
				<Select
					id="agent-usage-days"
					label="Period"
					value={String(days)}
					options={WINDOWS.map((w) => ({ value: String(w), label: `Last ${w} days` }))}
					onValueChange={(value) => setDays(AgentUsageWindow.parse(Number(value)))}
				/>
			</div>
			{usage.isError ? (
				<p className="pk-error text-status-error" role="alert">
					{usage.error instanceof ApiError
						? usage.error.message
						: "Agent usage could not be loaded."}
				</p>
			) : null}
			{data && data.users.length === 0 ? (
				<p className="pk-text-body pk-muted" data-testid="agent-usage-empty">
					No agent usage was reported in this period.
				</p>
			) : null}
			{data && data.users.length > 0 ? <UsageTables data={data} /> : null}
		</AdminSection>
	);
}
