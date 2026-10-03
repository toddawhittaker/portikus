import {
	AdminProcessSnapshot,
	type InstanceProcess,
	ProcessStopResponse,
} from "@portikus/contracts";
import {
	Button,
	ConfirmDialog,
	ConfirmDialogRoot,
	IconButton,
	Toggletip,
} from "@portikus/ui";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { ApiError, request, sendJson } from "../api/request.js";
import { formatBytes, formatCpu } from "../monitor/format.js";
import { stopErrorText } from "../monitor/stop.js";
import { SortAnnouncement, useAnnouncedSort } from "../table/announce.js";
import { SortHeader } from "../table/SortHeader.js";
import { type SortState, sortText } from "../table/sort.js";

/** The browser polls once a second for at most 20 seconds (SPEC.md §20.1). */
const POLL_MS = 1000;
export const POLL_LIMIT_MS = 20_000;

const PROTECTED_HELP =
	"Protected processes are the workspace's system processes and Portikus's own. They cannot be stopped here; restart the workspace instead.";

/** The workspace's student account; every other uid is shown as system. */
const STUDENT_UID = 1000;

export const TIMEOUT_TEXT =
	"The workspace did not send its processes in time. Press Refresh to try again.";

const RefreshAnswer = z.object({ requestedAt: z.string() });

/** A snapshot answers this browser's request only if taken after it, as the worker judges. */
export function snapshotAnswers(
	snapshot: AdminProcessSnapshot,
	requestedAt: string,
): boolean {
	return (
		snapshot.takenAt !== null && Date.parse(snapshot.takenAt) > Date.parse(requestedAt)
	);
}

export type ProcessSortColumn = "cpu" | "memory";

const SORT_LABELS: Record<ProcessSortColumn, string> = { cpu: "CPU", memory: "Memory" };

/**
 * Room before a sortable column for the faint hint chevron, which sits in the
 * cell's start padding (tables.css); its values line up under the label.
 */
const HINT_ROOM = "ps-[calc(var(--size-icon-sm)+3px)]";

const BUSIEST_FIRST: SortState<ProcessSortColumn> = {
	column: "cpu",
	direction: "descending",
};

/** Ties keep PID order in both directions, so the table does not jump. */
export function sortProcesses(
	rows: readonly InstanceProcess[],
	sort: SortState<ProcessSortColumn>,
): InstanceProcess[] {
	const value = (row: InstanceProcess) =>
		sort.column === "cpu" ? row.cpuPercent : row.residentBytes;
	const sign = sort.direction === "ascending" ? 1 : -1;
	return [...rows].sort((a, b) => sign * (value(a) - value(b)) || a.pid - b.pid);
}

export function ownerText(uid: number): string {
	return uid === STUDENT_UID ? "student" : "system";
}

function snapshotErrorText(code: string): string {
	if (code === "WORKSPACE_NOT_RUNNING") return "The workspace is not running.";
	return `The processes could not be read (${code}). Press Refresh to try again.`;
}

/** The dialog's words for a refused or failed stop; the refusals are Monitor's own. */
export function adminStopErrorText(error: unknown): string {
	const code = error instanceof ApiError ? error.code : undefined;
	switch (code) {
		case "PROCESS_NOT_FOUND":
		case "PROCESS_CHANGED":
		case "PROCESS_PROTECTED":
			return stopErrorText(error);
		case "WORKSPACE_NOT_RUNNING":
			return "The workspace is not running.";
		case "STOP_IN_PROGRESS":
			return "Another process in this workspace is being stopped. Try again in a moment.";
		default:
			return "That program could not be stopped. Try again, or restart the workspace.";
	}
}

type Reading =
	| { phase: "idle" }
	| { phase: "waiting" }
	| { phase: "done"; snapshot: AdminProcessSnapshot }
	| { phase: "failed"; message: string };

interface Stopping {
	process: InstanceProcess;
	/** True once a plain stop left the process running, so Force stop is offered. */
	stillRunning: boolean;
	error: string | null;
	pending: boolean;
}

function processKey(process: InstanceProcess): string {
	return `${process.pid}:${process.startTicks}`;
}

function readTime(iso: string): string {
	return new Date(iso).toLocaleTimeString(undefined, {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
}

/**
 * The administrator's process list for one workspace (SPEC.md §20.1, ADR 0034).
 * Read on demand only; names are the kernel's short names, shown as text.
 */
export function ProcessesSection({
	workspaceId,
	running,
	ownerName,
}: {
	workspaceId: string;
	running: boolean;
	ownerName: string;
}) {
	const [reading, setReading] = useState<Reading>({ phase: "idle" });
	const {
		sort,
		setSort,
		announcement: sortSpoken,
	} = useAnnouncedSort(BUSIEST_FIRST, SORT_LABELS);
	const [stopping, setStopping] = useState<Stopping | null>(null);
	const [stopped, setStopped] = useState<Set<string>>(() => new Set());
	const [announcement, setAnnouncement] = useState("");
	const [focusHeading, setFocusHeading] = useState(false);
	const headingRef = useRef<HTMLHeadingElement>(null);
	// Bumped on every Refresh and on unmount, so an old poll stops writing state.
	const generation = useRef(0);

	useEffect(() => {
		return () => {
			generation.current += 1;
		};
	}, []);

	useEffect(() => {
		if (!focusHeading) return;
		setFocusHeading(false);
		headingRef.current?.focus();
	}, [focusHeading]);

	async function refresh() {
		generation.current += 1;
		const mine = generation.current;
		const current = () => generation.current === mine;
		setReading({ phase: "waiting" });
		setAnnouncement("Reading the processes…");
		try {
			const { requestedAt } = await request(
				RefreshAnswer,
				`/admin/workspaces/${workspaceId}/processes/refresh`,
				{ method: "POST" },
			);
			const deadline = Date.now() + POLL_LIMIT_MS;
			while (current()) {
				await new Promise((resolve) => setTimeout(resolve, POLL_MS));
				if (!current()) return;
				const snapshot = await request(
					AdminProcessSnapshot,
					`/admin/workspaces/${workspaceId}/processes`,
				);
				if (!current()) return;
				if (snapshotAnswers(snapshot, requestedAt)) {
					if (snapshot.error) {
						const message = snapshotErrorText(snapshot.error);
						setReading({ phase: "failed", message });
						setAnnouncement(message);
					} else {
						setStopped(new Set());
						setReading({ phase: "done", snapshot });
						setAnnouncement(`${snapshot.processes.length} processes read.`);
					}
					return;
				}
				if (Date.now() >= deadline) {
					setReading({ phase: "failed", message: TIMEOUT_TEXT });
					setAnnouncement(TIMEOUT_TEXT);
					return;
				}
			}
		} catch (error) {
			if (!current()) return;
			const message =
				error instanceof ApiError && error.code === "WORKSPACE_NOT_RUNNING"
					? "The workspace is not running."
					: "The processes could not be read. Press Refresh to try again.";
			setReading({ phase: "failed", message });
			setAnnouncement(message);
		}
	}

	function close() {
		setStopping(null);
	}

	async function confirm(current: Stopping) {
		const { process } = current;
		const force = current.stillRunning;
		setStopping({ ...current, pending: true, error: null });
		try {
			const answer = await sendJson(
				ProcessStopResponse,
				`/admin/workspaces/${workspaceId}/processes/${process.pid}/stop`,
				{ startTicks: process.startTicks, force },
			);
			if (!answer.exited) {
				setStopping({ process, stillRunning: true, error: null, pending: false });
				return;
			}
			setStopped((previous) => new Set(previous).add(processKey(process)));
			setAnnouncement(`${process.name} (PID ${process.pid}) stopped.`);
			setStopping(null);
			// The Stop button that had focus has gone with its row.
			setFocusHeading(true);
		} catch (error) {
			setStopping({ ...current, pending: false, error: adminStopErrorText(error) });
		}
	}

	const rows =
		reading.phase === "done"
			? sortProcesses(
					reading.snapshot.processes.filter((row) => !stopped.has(processKey(row))),
					sort,
				)
			: [];

	return (
		<section
			aria-labelledby="detail-processes"
			className="pk-detail-section"
			data-testid="detail-processes"
		>
			<h4
				id="detail-processes"
				ref={headingRef}
				tabIndex={-1}
				// The panel's section heading style (WorkspaceDetail SECTION_HEADING).
				className="pk-text-compact m-0 font-semibold text-ink-muted outline-none"
			>
				Processes
			</h4>
			{/* Always mounted, so each outcome is announced (SPEC.md §25.8). */}
			<span role="status" className="sr-only" data-testid="processes-announce">
				{announcement}
			</span>
			<SortAnnouncement text={sortSpoken} testId="processes-sort-announce" />
			{!running ? (
				<p className="pk-text-compact pk-muted m-0">The workspace is not running.</p>
			) : reading.phase === "idle" ? (
				<p className="pk-text-compact pk-muted m-0">
					Press Refresh to read the processes.
				</p>
			) : reading.phase === "waiting" ? (
				<p className="pk-text-compact pk-muted m-0" aria-busy="true">
					Reading the processes…
				</p>
			) : reading.phase === "failed" ? (
				<p
					className="pk-text-compact m-0 text-status-error"
					data-testid="processes-error"
				>
					{reading.message}
				</p>
			) : (
				<>
					<p className="pk-text-compact pk-muted m-0" data-testid="processes-time">
						Read at {readTime(reading.snapshot.takenAt ?? "")}
					</p>
					<table
						// An 8 px gap between columns, none after the last. Headers are muted
						// and the sorted one is full ink, as in every .pk-table (tables.css).
						className="pk-text-compact w-full text-left [&_:is(th,td):not(:last-child)]:pe-[var(--space-2)] [&_th]:text-ink-muted [&_th[aria-sort]]:text-ink"
						data-testid="processes-table"
					>
						<caption className="sr-only">
							Processes, {sortText(SORT_LABELS[sort.column], sort.direction)}
						</caption>
						<thead>
							<tr>
								{/* Only CPU and Memory sort: the reading is for finding what is busy. */}
								<th scope="col">PID</th>
								<th scope="col">Owner</th>
								<th scope="col">Name</th>
								<SortHeader
									column="cpu"
									label={SORT_LABELS.cpu}
									sort={sort}
									onSort={setSort}
									first="descending"
									className={HINT_ROOM}
								/>
								<SortHeader
									column="memory"
									label={SORT_LABELS.memory}
									sort={sort}
									onSort={setSort}
									first="descending"
									className={HINT_ROOM}
								/>
								<th scope="col">
									<span className="sr-only">Actions</span>
									<Toggletip label="Protected processes">{PROTECTED_HELP}</Toggletip>
								</th>
							</tr>
						</thead>
						<tbody>
							{rows.length === 0 ? (
								<tr>
									<td colSpan={6}>No processes</td>
								</tr>
							) : (
								rows.map((row) => (
									<tr key={processKey(row)} data-testid={`process-row-${row.pid}`}>
										<td className="pk-mono-small">{row.pid}</td>
										<td>{ownerText(row.uid)}</td>
										<td className="pk-mono-small break-all">{row.name}</td>
										<td className={HINT_ROOM}>{formatCpu(row.cpuPercent)}</td>
										<td className={HINT_ROOM}>{formatBytes(row.residentBytes)}</td>
										<td>
											<div className="pk-action-slots">
												{row.protected ? (
													<span
														className="pk-muted pk-action-note"
														data-testid={`processes-protected-${row.pid}`}
													>
														Protected
														<span className="sr-only">
															: the system or Portikus needs this process, so it cannot
															be stopped here.
														</span>
													</span>
												) : (
													<span className="pk-action-slot">
														<IconButton
															icon="stop"
															size="sm"
															className="pk-iconbtn-danger"
															label={`Stop ${row.name} (PID ${row.pid})`}
															aria-haspopup="dialog"
															data-testid={`processes-stop-${row.pid}`}
															onClick={() =>
																setStopping({
																	process: row,
																	stillRunning: false,
																	error: null,
																	pending: false,
																})
															}
														/>
													</span>
												)}
											</div>
										</td>
									</tr>
								))
							)}
						</tbody>
					</table>
				</>
			)}
			{running ? (
				<div className="pk-actions">
					<Button
						size="sm"
						aria-label={`Refresh processes in ${ownerName}'s workspace`}
						loading={reading.phase === "waiting"}
						onClick={() => {
							if (reading.phase !== "waiting") void refresh();
						}}
						data-testid="processes-refresh"
					>
						Refresh
					</Button>
				</div>
			) : null}
			{stopping ? (
				<ConfirmDialogRoot open onOpenChange={(open) => !open && close()}>
					<ConfirmDialog
						testId="dialog-admin-stop-process"
						title={`Stop ${stopping.process.name}?`}
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
		</section>
	);
}

function StopDescription({ stopping }: { stopping: Stopping }) {
	const { process } = stopping;
	return (
		<>
			{/* A live region inside the dialog, so the outcome is heard where focus is. */}
			<span role="status" className="block" data-testid="admin-stop-status">
				{stopping.error ??
					(stopping.stillRunning ? `${process.name} is still running.` : "")}
			</span>
			<span className="block">
				{stopping.stillRunning
					? `Force stop ends PID ${process.pid} at once, without letting it clean up.`
					: `PID ${process.pid} is asked to stop.`}
			</span>
			<span className="block">
				The student is told that an administrator stopped a process.
			</span>
		</>
	);
}
