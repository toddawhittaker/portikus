import type { Project, Workspace } from "@portikus/contracts";
import { Icon } from "@portikus/ui";
import { useRef } from "react";
import { gitBar } from "../files/gitStatus.js";
import { useGitStatus } from "../files/useGitStatus.js";
import { formatBytes } from "../monitor/format.js";
import { STORAGE_POLL_MS, useWorkspaceUsage } from "../monitor/usage.js";
import { CRITICAL_AT, storageWarning } from "../recovery/storage.js";
import { useShowMonitor } from "./rightPane.js";
import { useCountdown } from "./useCountdown.js";
import {
	resolveStatus,
	WorkspaceDialog,
	type WorkspaceDialogMode,
} from "./WorkspaceDialog.js";

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
export const METER_WARN_AT = 0.85;

/** Once warning, a meter stays so until use falls below this, so it does not flicker. */
export const METER_CLEAR_BELOW = 0.8;

/** Disk turns to the error tone here, the storage warning's "nearly full" line. */
export const METER_FULL_AT = CRITICAL_AT;

/** Fixed text for the live region, so a changing figure is not re-announced. */
export const MEMORY_ANNOUNCEMENT = "Your workspace is using most of its memory.";

export interface Meter {
	/** "{used} of {total}". */
	value: string;
	/** How full, 0 to 100, for the bar. */
	percent: number;
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
): Meter | null {
	if (!figure || figure.totalBytes <= 0) return null;
	const share = figure.usedBytes / figure.totalBytes;
	const level =
		canBeFull && share >= METER_FULL_AT
			? "full"
			: share >= (warning ? METER_CLEAR_BELOW : METER_WARN_AT)
				? "warning"
				: "ok";
	return {
		value: `${formatBytes(figure.usedBytes)} of ${formatBytes(figure.totalBytes)}`,
		percent: Math.min(100, share * 100),
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
	const running = workspace?.state === "running";
	const usage = useWorkspaceUsage(workspaceId, running, STORAGE_POLL_MS);
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

	return (
		<footer className="pk-statusbar" data-testid="status-bar">
			<span
				className="pk-statusbar-item pk-statusbar-mono pk-statusbar-path"
				title={project ? `~/projects/${project.slug}` : "~/projects"}
			>
				{project ? `~/projects/${project.slug}` : "~/projects"}
			</span>
			{project && !project.missing ? (
				<GitSegment workspaceId={workspaceId} projectId={project.id} />
			) : null}
			<span className="pk-statusbar-spacer" />
			{countdown && (
				<span className="pk-statusbar-item pk-tone-warning">
					Stopping in {countdown.clock}
				</span>
			)}
			{/* Announce a storage class or memory crossing a threshold (SPEC.md §19.2). */}
			<span role="status" className="sr-only" data-testid="storage-warning-announce">
				{warning?.announcement ?? ""}
			</span>
			<span role="status" className="sr-only" data-testid="memory-warning-announce">
				{memory && memory.level !== "ok" ? MEMORY_ANNOUNCEMENT : ""}
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
				<span data-testid="workspace-state" role="status">
					{resolved.label}
				</span>
				<Icon name="chevron-up" size="sm" />
			</button>

			<WorkspaceDialog
				workspaceId={workspaceId}
				workspace={workspace}
				dialog={dialog}
				onDialogChange={onDialogChange}
				storage={storage}
				warningDetail={warning?.detail ?? null}
			/>
		</footer>
	);
}

const METER_CLASS: Record<Meter["level"], string> = {
	ok: "",
	warning: "pk-meter--warning",
	full: "pk-meter--full",
};

/**
 * An always-visible meter (SPEC.md §19.2). Its name starts with
 * the visible text; the bar is decoration. High use adds the alert icon and
 * "high" to the name, so it is not told by colour alone.
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
	meter: Meter;
	action: string;
	testId: string;
	dialog?: boolean;
	onClick: () => void;
}) {
	const high = meter.level !== "ok";
	const note = meter.level === "full" ? ", nearly full" : high ? ", high" : "";
	return (
		<button
			type="button"
			className={`pk-statusbar-item pk-statusbar-meter pk-meter ${METER_CLASS[meter.level]}`}
			data-testid={testId}
			data-level={meter.level}
			aria-haspopup={dialog ? "dialog" : undefined}
			aria-label={`${label} ${meter.value}${note}. ${action}`}
			onClick={onClick}
		>
			<span className="pk-meter-label">{label}</span>
			<span className="pk-meter-value">
				{high ? <Icon name="alert" size="sm" /> : null}
				{meter.value}
			</span>
			<span className="pk-meter-track" aria-hidden="true">
				<span className="pk-meter-fill" style={{ width: `${meter.percent}%` }} />
			</span>
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
