import type { Project, Workspace } from "@portikus/contracts";
import { Icon, Meter, meterText } from "@portikus/ui";
import { useRef } from "react";
import { gitBar } from "../files/gitStatus.js";
import { useGitStatus } from "../files/useGitStatus.js";
import { formatBytes } from "../monitor/format.js";
import { STORAGE_POLL_MS, useWorkspaceUsage } from "../monitor/usage.js";
import { CRITICAL_AT, storageWarning } from "../recovery/storage.js";
import { formatHoldEnd, holdActive, useStudentTimezone } from "./KeepRunning.js";
import { useShowMonitor } from "./rightPane.js";
import { useCountdown } from "./useCountdown.js";
import {
	resolveStatus,
	UNVERIFIED_EXPLANATION,
	WorkspaceDialog,
	type WorkspaceDialogMode,
} from "./WorkspaceDialog.js";
import "./status-bar.css";

export { PENDING_LABEL } from "./WorkspaceDialog.js";

const TONE_CLASS: Record<string, string> = {
	running: "pk-tone-running",
	starting: "pk-tone-starting",
	provisioning: "pk-tone-starting",
	stopping: "pk-tone-starting",
	stopped: "pk-tone-stopped",
	error: "pk-tone-error",
};

/** A status bar meter turns to the warning tone from this share of the limit up. */
const METER_WARN_AT = 0.85;

/** Once warning, a meter stays so until use falls below this, so it does not flicker. */
const METER_CLEAR_BELOW = 0.8;

/** Disk turns to the error tone here, the storage warning's "nearly full" line. */
const METER_FULL_AT = CRITICAL_AT;

/** Fixed text for the live region when the state turns unconfirmed (SPEC.md §18.3). */
export const UNVERIFIED_ANNOUNCEMENT =
	"Workspace state is unconfirmed. Portikus can't reach the workspace host right now.";

/** Fixed text for the live region, so a changing figure is not re-announced. */
export const MEMORY_ANNOUNCEMENT = "Your workspace is using most of its memory.";

export interface UsageMeter {
	usedBytes: number;
	totalBytes: number;
	/** The Meter's warning mark: the threshold in force, so it warns exactly when `level` does. */
	high: number;
	/** "{used} of {total}", read by the meter and in the button's name. */
	valueText: string;
	/** "{percent}%", the visible text, so the bar keeps to one line. */
	shortText: string;
	level: "ok" | "warning" | "full";
}

/**
 * One status bar meter: warning at or above 85% of the limit, or at or above
 * 80% while it is already `warning`, and full from 95% when `canBeFull`
 * (SPEC.md §19.2). Null when there is no figure to show.
 */
export function usageMeter(
	figure: { usedBytes: number; totalBytes: number } | null | undefined,
	warning = false,
	canBeFull = false,
): UsageMeter | null {
	if (!figure || figure.totalBytes <= 0) return null;
	const share = figure.usedBytes / figure.totalBytes;
	const warnAt = warning ? METER_CLEAR_BELOW : METER_WARN_AT;
	const level =
		canBeFull && share >= METER_FULL_AT ? "full" : share >= warnAt ? "warning" : "ok";
	return {
		usedBytes: figure.usedBytes,
		totalBytes: figure.totalBytes,
		// The Meter warns strictly past `high`; this level warns from the threshold itself.
		high: figure.totalBytes * warnAt - 1,
		valueText: `${formatBytes(figure.usedBytes)} of ${formatBytes(figure.totalBytes)}`,
		// Rounded down, so 94.9% never reads as the 95% where Disk turns full.
		shortText: `${Math.floor(share * 100)}%`,
		level,
	};
}

/** The bottom bar: where you are, and the workspace state, which opens its dialog. */
export function StatusBar({
	workspaceId,
	project,
	workspace,
	dialog,
	onDialogChange,
}: {
	workspaceId: string;
	project: Project | undefined;
	workspace: Workspace | null;
	dialog: WorkspaceDialogMode;
	onDialogChange: (mode: WorkspaceDialogMode) => void;
}) {
	const setStatusOpen = (open: boolean) => onDialogChange(open ? "open" : "closed");
	const resolved = resolveStatus(workspace);
	const unverified = workspace?.stateVerified === false;
	const running = workspace?.state === "running";
	// The agent may still answer in error, and the error screen shows its figures (SPEC.md §28).
	const errored = workspace?.state === "error";
	const usage = useWorkspaceUsage(
		workspaceId,
		running || errored,
		STORAGE_POLL_MS,
		errored,
	);
	const storage = running ? usage.data?.storage : undefined;
	const warning = storageWarning(storage);
	const memoryWarned = useRef(false);
	const memory = running ? usageMeter(usage.data?.memory, memoryWarned.current) : null;
	memoryWarned.current = memory !== null && memory.level !== "ok";
	const diskWarned = useRef(false);
	const disk = running ? usageMeter(storage?.home, diskWarned.current, true) : null;
	diskWarned.current = disk !== null && disk.level !== "ok";
	const showMonitor = useShowMonitor();
	const countdown = useCountdown(workspace?.shutdownDeadline ?? null);
	const timeZone = useStudentTimezone();
	const holdUntil =
		running && holdActive(workspace) ? (workspace?.keepRunningUntil ?? null) : null;

	return (
		<footer className="pk-statusbar" data-testid="status-bar">
			{/* Where you are, then the workspace; the second group wraps under the first when narrow. */}
			<div className="pk-statusbar-where">
				<span
					className="pk-statusbar-item pk-statusbar-mono pk-statusbar-path"
					title={project ? `~/projects/${project.slug}` : "~/projects"}
				>
					{project ? `~/projects/${project.slug}` : "~/projects"}
				</span>
				{project && !project.missing ? (
					<GitSegment workspaceId={workspaceId} projectId={project.id} />
				) : null}
			</div>
			<div className="pk-statusbar-status">
				{countdown && (
					<span className="pk-statusbar-item pk-tone-warning">
						Stopping in {countdown.clock}
					</span>
				)}
				{holdUntil ? (
					<button
						type="button"
						className="pk-statusbar-item"
						aria-haspopup="dialog"
						data-testid="keep-running-indicator"
						onClick={() => setStatusOpen(true)}
					>
						Kept running until {formatHoldEnd(holdUntil, timeZone)}
						<Icon name="chevron-up" size="sm" />
					</button>
				) : null}
				{/* Announce a storage class or memory crossing a threshold (SPEC.md §19.2). */}
				<span
					role="status"
					aria-live="polite"
					className="sr-only"
					data-testid="storage-warning-announce"
				>
					{warning?.announcement ?? ""}
				</span>
				<span
					role="status"
					aria-live="polite"
					className="sr-only"
					data-testid="memory-warning-announce"
				>
					{memory && memory.level !== "ok" ? MEMORY_ANNOUNCEMENT : ""}
				</span>
				<span
					role="status"
					aria-live="polite"
					className="sr-only"
					data-testid="state-unverified-announce"
				>
					{unverified ? UNVERIFIED_ANNOUNCEMENT : ""}
				</span>
				{/* Outside the button, so an open dialog's aria-hidden still hides the button. */}
				<span
					role="status"
					aria-live="polite"
					className="sr-only"
					data-testid="workspace-state-announce"
				>
					{resolved.label}
				</span>
				{memory ? (
					<MeterButton
						label="Memory"
						meter={memory}
						action="See what's using memory"
						testId="memory-meter"
						onClick={() => showMonitor("memory")}
					/>
				) : null}
				{disk ? (
					<MeterButton
						label="Disk"
						meter={disk}
						action="Open workspace storage"
						testId="disk-meter"
						dialog
						onClick={() => setStatusOpen(true)}
					/>
				) : null}
				{warning ? (
					<button
						type="button"
						className={`pk-statusbar-item ${warning.level === "critical" ? "pk-tone-error" : "pk-tone-warning"}`}
						aria-haspopup="dialog"
						data-testid="storage-warning"
						data-level={warning.level}
						onClick={() => setStatusOpen(true)}
					>
						{warning.text}
						<Icon name="chevron-up" size="sm" />
					</button>
				) : null}
				<button
					type="button"
					className="pk-statusbar-item pk-statusbar-plain"
					aria-haspopup="dialog"
					data-testid="workspace-status"
					onClick={() => setStatusOpen(true)}
				>
					<span
						className={`pk-dot ${TONE_CLASS[resolved.tone] ?? "pk-tone-stopped"}`}
						aria-hidden="true"
					/>
					<span data-testid="workspace-state">{resolved.label}</span>
					{unverified ? (
						<span
							className="pk-statusbar-item pk-tone-warning"
							data-testid="workspace-state-unverified"
						>
							<Icon name="alert" size="sm" />
							<span aria-hidden="true">unconfirmed</span>
							{/* One hidden run, so the name reads "unconfirmed. Portikus…" with no stray space. */}
							<span className="pk-visually-hidden">
								unconfirmed. {UNVERIFIED_EXPLANATION}
							</span>
						</span>
					) : null}
					<Icon name="chevron-up" size="sm" />
				</button>
			</div>

			<WorkspaceDialog
				workspaceId={workspaceId}
				workspace={workspace}
				dialog={dialog}
				onDialogChange={onDialogChange}
				storage={running || errored ? usage.data?.storage : undefined}
				warningDetail={warning?.detail ?? null}
			/>
		</footer>
	);
}

const METER_CLASS: Record<UsageMeter["level"], string> = {
	ok: "",
	warning: "pk-meter--warning",
	full: "pk-meter--full",
};

/**
 * An always-visible meter (SPEC.md §19.2) on the ui Meter. It shows the
 * label and a percentage; its name starts with those visible words, then
 * the full figure and what it opens. High use adds the alert icon, and
 * "nearly full" to the name, so it is not told by colour alone (SPEC.md §25.8).
 */
function MeterButton({
	label,
	meter,
	action,
	testId,
	dialog = false,
	onClick,
}: {
	label: string;
	meter: UsageMeter;
	action: string;
	testId: string;
	dialog?: boolean;
	onClick: () => void;
}) {
	const shown = {
		value: meter.usedBytes,
		max: meter.totalBytes,
		high: meter.high,
		valueText: meter.valueText,
	};
	return (
		<button
			type="button"
			className={`pk-statusbar-item pk-statusbar-meter pk-meter ${METER_CLASS[meter.level]}`}
			data-testid={testId}
			data-level={meter.level}
			aria-haspopup={dialog ? "dialog" : undefined}
			aria-label={`${label} ${meter.shortText}, ${meterText(shown)}. ${action}`}
			onClick={onClick}
		>
			<span className="pk-meter-label">{label}</span>
			<Meter label={label} {...shown} shortText={meter.shortText} />
		</button>
	);
}

/**
 * The compact Git line of SPEC.md §12.8. Conflicts are drawn in the warning
 * tone, because an unresolved merge is not an ordinary change.
 */
function GitSegment({
	workspaceId,
	projectId,
}: {
	workspaceId: string;
	projectId: string;
}) {
	const status = useGitStatus(workspaceId, projectId);
	const bar = gitBar(status.data);
	if (!bar) return null;
	const tone = !bar.repo
		? "pk-statusbar-muted"
		: bar.conflicts > 0
			? "pk-tone-warning"
			: "";
	return (
		<span
			className={`pk-statusbar-item pk-statusbar-git ${tone}`}
			title={bar.text}
			data-testid="git-status"
			data-conflicts={bar.conflicts > 0 ? "true" : undefined}
		>
			{bar.text}
		</span>
	);
}
