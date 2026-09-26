import type { Project, Workspace } from "@portikus/contracts";
import { Icon } from "@portikus/ui";
import { gitBar } from "../files/gitStatus.js";
import { useGitStatus } from "../files/useGitStatus.js";
import { STORAGE_POLL_MS, useWorkspaceUsage } from "../monitor/usage.js";
import { storageWarning } from "../recovery/storage.js";
import { useCountdown } from "./useCountdown.js";
import {
	resolveStatus,
	WorkspaceDialog,
	type WorkspaceDialogMode,
} from "./WorkspaceDialog.js";

export { PENDING_LABEL, type WorkspaceDialogMode } from "./WorkspaceDialog.js";

const TONE_CLASS: Record<string, string> = {
	running: "pk-tone-running",
	starting: "pk-tone-starting",
	provisioning: "pk-tone-starting",
	stopping: "pk-tone-starting",
	stopped: "pk-tone-stopped",
	error: "pk-tone-error",
};

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
	const countdown = useCountdown(workspace?.shutdownDeadline ?? null);

	return (
		<footer className="pk-statusbar" data-testid="status-bar">
			<span className="pk-statusbar-item pk-statusbar-mono">
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
			{/* Announces a class crossing a threshold (SPEC.md §19.2). */}
			<span role="status" className="sr-only" data-testid="storage-warning-announce">
				{warning?.announcement ?? ""}
			</span>
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
			className={`pk-statusbar-item ${tone}`}
			data-testid="git-status"
			data-conflicts={bar.conflicts > 0 ? "true" : undefined}
		>
			{bar.text}
		</span>
	);
}
