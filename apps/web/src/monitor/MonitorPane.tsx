/**
 * The Monitor tab (SPEC.md §18.3): workspace CPU, memory, the home disk,
 * network rates, and the processes in the workspace. It refreshes once a second
 * while it is the selected tab, and it does not manage processes.
 */
import type { UsageProcess, WorkspaceUsage } from "@portikus/contracts";
import "./monitor.css";
import { formatBytes, formatCpu, formatRate } from "./format.js";
import { useWorkspaceUsage } from "./usage.js";

export function MonitorPane({ workspaceId }: { workspaceId: string }) {
	const query = useWorkspaceUsage(workspaceId, true);
	const usage = query.data;

	return (
		<>
			<div className="pk-pane-head">
				<h2 className="pk-pane-title">Monitor</h2>
			</div>
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
	const processes = [...usage.processes].sort(byLoad);
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
						<th>PID</th>
						<th>CPU</th>
						<th>Memory</th>
						<th>Command</th>
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

/** Busiest first. A process with no sample yet sorts as idle. */
function byLoad(left: UsageProcess, right: UsageProcess): number {
	const cpu = (right.cpuPercent ?? -1) - (left.cpuPercent ?? -1);
	if (cpu !== 0) return cpu;
	return right.residentBytes - left.residentBytes || left.pid - right.pid;
}
