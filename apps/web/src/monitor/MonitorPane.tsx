/**
 * The Monitor tab (SPEC.md §18.3): workspace CPU, memory, the home disk,
 * network rates, and the processes in the workspace. It refreshes once a second
 * while it is the selected tab. A student can stop their own processes and
 * read a process's full command line (docs/EPIC-21.md rulings 20 and 21).
 */
import type { UsageProcess, WorkspaceUsage } from "@portikus/contracts";
import { ConfirmDialog, ConfirmDialogRoot, IconButton } from "@portikus/ui";
import { useEffect, useRef, useState } from "react";
import "./monitor.css";
import { useRightPaneState } from "../shell/rightPane.js";
import { formatBytes, formatCpu, formatRate } from "./format.js";
import {
	compareProcesses,
	type ProcessColumn,
	type ProcessSort,
	toggleProcessSort,
} from "./sort.js";
import { stopErrorText, stopProcess } from "./stop.js";
import { useWorkspaceUsage } from "./usage.js";

export function MonitorPane({ workspaceId }: { workspaceId: string }) {
	const query = useWorkspaceUsage(workspaceId, true);
	const usage = query.data;

	return (
		<>
			<h2 className="sr-only">Monitor</h2>
			<div className="pk-pane-body pk-monitor" data-testid="monitor">
				{usage ? (
					<Figures workspaceId={workspaceId} usage={usage} />
				) : (
					<p className="pk-hint" data-testid="monitor-status">
						{query.isError ? "Usage could not be read." : "Reading usage…"}
					</p>
				)}
			</div>
		</>
	);
}

/** One process, named by its PID and start ticks, as the stop route wants it. */
function processKey(process: UsageProcess): string {
	return `${process.pid}:${process.startTicks}`;
}

interface Stopping {
	process: UsageProcess;
	/** True once a plain stop left the process running, so Force stop is offered. */
	stillRunning: boolean;
	error: string | null;
	pending: boolean;
}

function Figures({
	workspaceId,
	usage,
}: {
	workspaceId: string;
	usage: WorkspaceUsage;
}) {
	const { monitorSort: sort, setMonitorSort: setSort } = useRightPaneState();
	const [stopping, setStopping] = useState<Stopping | null>(null);
	const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
	// Hidden at once, so the row does not linger until the next sample.
	const [stopped, setStopped] = useState<Set<string>>(() => new Set());
	const [announcement, setAnnouncement] = useState("");
	const [focusHeading, setFocusHeading] = useState(false);
	const headingRef = useRef<HTMLHeadingElement>(null);

	const processes = usage.processes
		.filter((process) => !stopped.has(processKey(process)))
		.sort((left, right) => compareProcesses(left, right, sort));

	// The Stop button that had focus has gone with its row, so focus moves to
	// the list's heading rather than falling to the page.
	useEffect(() => {
		if (!focusHeading) return;
		setFocusHeading(false);
		headingRef.current?.focus();
	}, [focusHeading]);

	function close() {
		const current = stopping?.process;
		setStopping(null);
		if (current && !processes.some((row) => processKey(row) === processKey(current))) {
			setFocusHeading(true);
		}
	}

	async function confirm(current: Stopping) {
		const { process } = current;
		const force = current.stillRunning;
		setStopping({ ...current, pending: true, error: null });
		try {
			const answer = await stopProcess(
				workspaceId,
				process.pid,
				process.startTicks,
				force,
			);
			if (!answer.exited) {
				setStopping({ process, stillRunning: true, error: null, pending: false });
				return;
			}
			setStopped((previous) => new Set(previous).add(processKey(process)));
			setAnnouncement(`${process.command} (PID ${process.pid}) stopped.`);
			setStopping(null);
			setFocusHeading(true);
		} catch (error) {
			setStopping({ ...current, pending: false, error: stopErrorText(error) });
		}
	}

	function toggleExpanded(key: string) {
		setExpanded((previous) => {
			const next = new Set(previous);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	}

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
			<h3
				className="pk-monitor-heading"
				ref={headingRef}
				tabIndex={-1}
				data-testid="monitor-processes-heading"
			>
				Processes
			</h3>
			{/* Always mounted, so a finished stop is announced (SPEC.md §25.8). */}
			<span role="status" className="sr-only" data-testid="monitor-stop-announce">
				{announcement}
			</span>
			<table className="pk-monitor-procs" data-testid="monitor-processes">
				<thead>
					<tr>
						<SortHeader column="pid" label="PID" sort={sort} onSort={setSort} />
						<SortHeader column="cpu" label="CPU" sort={sort} onSort={setSort} />
						<SortHeader column="memory" label="Memory" sort={sort} onSort={setSort} />
						<SortHeader column="command" label="Command" sort={sort} onSort={setSort} />
						<th>
							<span className="sr-only">Actions</span>
						</th>
					</tr>
				</thead>
				<tbody>
					{processes.length === 0 ? (
						<tr>
							<td colSpan={5}>No processes</td>
						</tr>
					) : (
						processes.map((process) => (
							<ProcessRow
								key={processKey(process)}
								process={process}
								expanded={expanded.has(processKey(process))}
								onToggle={() => toggleExpanded(processKey(process))}
								onStop={() =>
									setStopping({
										process,
										stillRunning: false,
										error: null,
										pending: false,
									})
								}
							/>
						))
					)}
				</tbody>
			</table>
			{stopping ? (
				<ConfirmDialogRoot open onOpenChange={(open) => !open && close()}>
					<ConfirmDialog
						testId="dialog-stop-process"
						title={`Stop ${stopping.process.command}?`}
						description={<StopDescription stopping={stopping} />}
						confirmLabel={stopping.stillRunning ? "Force stop" : "Stop"}
						pending={stopping.pending}
						onCancel={close}
						onConfirm={() => {
							if (!stopping.pending) void confirm(stopping);
						}}
					/>
				</ConfirmDialogRoot>
			) : null}
		</>
	);
}

function StopDescription({ stopping }: { stopping: Stopping }) {
	const { process } = stopping;
	return (
		<>
			{/* A live region inside the dialog, so the outcome is heard where focus is. */}
			<span
				role="status"
				className="pk-monitor-dialog-line"
				data-testid="stop-process-status"
			>
				{stopping.error ??
					(stopping.stillRunning ? `${process.command} is still running.` : "")}
			</span>
			<span className="pk-monitor-dialog-line">
				{stopping.stillRunning
					? `Force stop ends PID ${process.pid} at once, without letting it clean up.`
					: `PID ${process.pid} is asked to stop.`}
			</span>
		</>
	);
}

function ProcessRow({
	process,
	expanded,
	onToggle,
	onStop,
}: {
	process: UsageProcess;
	expanded: boolean;
	onToggle: () => void;
	onStop: () => void;
}) {
	const detailId = `monitor-command-${process.pid}`;
	return (
		<>
			<tr data-testid={`monitor-process-${process.pid}`}>
				<td>{process.pid}</td>
				<td>{formatCpu(process.cpuPercent)}</td>
				<td>{formatBytes(process.residentBytes)}</td>
				<td className="pk-monitor-command" title={process.command}>
					{process.command}
				</td>
				<td className="pk-monitor-actions">
					{process.commandLine !== null ? (
						<IconButton
							icon={expanded ? "chevron-down" : "chevron-right"}
							size="sm"
							label={`Show the full command for PID ${process.pid}`}
							aria-expanded={expanded}
							aria-controls={expanded ? detailId : undefined}
							data-testid={`monitor-show-command-${process.pid}`}
							onClick={onToggle}
						/>
					) : null}
					{process.stoppable ? (
						<IconButton
							icon="stop"
							size="sm"
							label={`Stop ${process.command} (PID ${process.pid})`}
							aria-haspopup="dialog"
							data-testid={`monitor-stop-${process.pid}`}
							onClick={onStop}
						/>
					) : null}
				</td>
			</tr>
			{expanded && process.commandLine !== null ? (
				<tr className="pk-monitor-cmdline-row">
					<td colSpan={5} id={detailId} data-testid={detailId}>
						{process.commandLine}
					</td>
				</tr>
			) : null}
		</>
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
