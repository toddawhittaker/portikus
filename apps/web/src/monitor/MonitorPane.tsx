/**
 * The Monitor tab (SPEC.md §18.3): workspace CPU, memory, the home disk,
 * network rates, and the processes in the workspace. It refreshes once a second
 * while it is the selected tab, and it does not manage processes.
 */
import type { UsageProcess, WorkspaceUsage } from "@portikus/contracts";
import { useState } from "react";
import "./monitor.css";
import { formatBytes, formatCpu, formatRate } from "./format.js";
import {
	compareProcesses,
	DEFAULT_PROCESS_SORT,
	type ProcessColumn,
	type ProcessSort,
	toggleProcessSort,
} from "./sort.js";
import { useWorkspaceUsage } from "./usage.js";

export function MonitorPane({ workspaceId }: { workspaceId: string }) {
	const query = useWorkspaceUsage(workspaceId, true);
	const usage = query.data;

	return (
		<>
			<h2 className="sr-only">Monitor</h2>
			<div className="pk-pane-body pk-monitor" data-testid="monitor">
				{usage ? (
					<Figures usage={usage} />
				) : (
					<p className="pk-hint" data-testid="monitor-status">
						{query.isError ? "Usage could not be read." : "Reading usage…"}
					</p>
				)}
			</div>
		</>
	);
}

function Figures({ usage }: { usage: WorkspaceUsage }) {
	const [sort, setSort] = useState<ProcessSort>(DEFAULT_PROCESS_SORT);
	const processes = [...usage.processes].sort((left, right) =>
		compareProcesses(left, right, sort),
	);
	return (
		<>
			<dl className="pk-monitor-stats">
				<dt>CPU</dt>
				<dd data-testid="monitor-cpu">{formatCpu(usage.cpuPercent)}</dd>
				<dt>Memory</dt>
				<dd data-testid="monitor-memory">
					{formatBytes(usage.memory.usedBytes)} / {formatBytes(usage.memory.totalBytes)}
				</dd>
				<dt>Disk</dt>
				<dd data-testid="monitor-disk">
					{formatBytes(usage.disk.usedBytes)} / {formatBytes(usage.disk.totalBytes)}
				</dd>
				<dt>Receive</dt>
				<dd data-testid="monitor-receive">
					{formatRate(usage.network.receiveBytesPerSecond)}
				</dd>
				<dt>Transmit</dt>
				<dd data-testid="monitor-transmit">
					{formatRate(usage.network.transmitBytesPerSecond)}
				</dd>
			</dl>
			<h3 className="pk-monitor-heading">Processes</h3>
			<table className="pk-monitor-procs" data-testid="monitor-processes">
				<thead>
					<tr>
						<SortHeader column="pid" label="PID" sort={sort} onSort={setSort} />
						<SortHeader column="cpu" label="CPU" sort={sort} onSort={setSort} />
						<SortHeader column="memory" label="Memory" sort={sort} onSort={setSort} />
						<SortHeader column="command" label="Command" sort={sort} onSort={setSort} />
					</tr>
				</thead>
				<tbody>
					{processes.length === 0 ? (
						<tr>
							<td colSpan={4}>No processes</td>
						</tr>
					) : (
						processes.map((process) => (
							<ProcessRow key={process.pid} process={process} />
						))
					)}
				</tbody>
			</table>
		</>
	);
}

function ProcessRow({ process }: { process: UsageProcess }) {
	return (
		<tr data-testid={`monitor-process-${process.pid}`}>
			<td>{process.pid}</td>
			<td>{formatCpu(process.cpuPercent)}</td>
			<td>{formatBytes(process.residentBytes)}</td>
			<td title={process.command}>{process.command}</td>
		</tr>
	);
}

function SortHeader({
	column,
	label,
	sort,
	onSort,
}: {
	column: ProcessColumn;
	label: string;
	sort: ProcessSort;
	onSort: (next: ProcessSort) => void;
}) {
	const active = sort.column === column;
	return (
		<th
			aria-sort={
				active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"
			}
		>
			<button type="button" onClick={() => onSort(toggleProcessSort(sort, column))}>
				{label}
			</button>
		</th>
	);
}
