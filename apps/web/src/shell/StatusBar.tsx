import type {
	PendingOperation,
	Project,
	Workspace,
	WorkspaceUsage,
} from "@portikus/contracts";
import {
	Button,
	ConfirmDialog,
	ConfirmDialogRoot,
	Dialog,
	DialogRoot,
	resolveWorkspaceState,
	useToast,
} from "@portikus/ui";
import { useState } from "react";
import { useWorkspaceAction } from "../api/workspace.js";
import { gitBar } from "../files/gitStatus.js";
import { useGitStatus } from "../files/useGitStatus.js";
import { formatBytes } from "../monitor/format.js";
import { STORAGE_POLL_MS, useWorkspaceUsage } from "../monitor/usage.js";
import { DialogError } from "../projects/DialogError.js";
import { useResetDocker } from "../recovery/queries.js";
import {
	STORAGE_CLASSES,
	STORAGE_LABEL,
	storageLevel,
	storageWarning,
} from "../recovery/storage.js";
import { useCountdown } from "./useCountdown.js";

const TONE_CLASS: Record<string, string> = {
	running: "pk-tone-running",
	starting: "pk-tone-starting",
	provisioning: "pk-tone-starting",
	stopping: "pk-tone-starting",
	stopped: "pk-tone-stopped",
	error: "pk-tone-error",
};

/** What the status shows while a maintenance operation waits or runs (SPEC.md §27). */
export const PENDING_LABEL: Record<PendingOperation, string> = {
	"reset-docker": "Resetting Docker…",
	rebuild: "Rebuilding…",
	"rebuild-reset-docker": "Rebuilding…",
};

/** The workspace state, or the pending operation when there is one. */
function resolveStatus(workspace: Workspace | null): {
	tone: string;
	label: string;
	moving: boolean;
} {
	if (!workspace) return { tone: "starting", label: "Connecting", moving: true };
	if (workspace.pendingOperation)
		return {
			tone: "starting",
			label: PENDING_LABEL[workspace.pendingOperation],
			moving: true,
		};
	return resolveWorkspaceState(workspace.state, workspace.desiredState);
}

type Confirming = "stop" | "restart" | "reset-docker" | null;

/** Image fingerprints are 64 characters; a student only ever needs the head of one. */
function shortImage(imageVersion: string | null): string {
	if (!imageVersion) return "—";
	return imageVersion.length > 12 ? `${imageVersion.slice(0, 12)}…` : imageVersion;
}

/** The bottom bar: where you are, and the workspace state, which opens its dialog. */
export function StatusBar({
	workspaceId,
	project,
	workspace,
}: {
	workspaceId: string;
	project: Project | undefined;
	workspace: Workspace | null;
}) {
	const [statusOpen, setStatusOpen] = useState(false);
	// The confirmation open on top of the workspace dialog, if any.
	const [confirming, setConfirming] = useState<Confirming>(null);
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
			<span role="status" className="contents">
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
					</button>
				) : null}
			</span>
			<button
				type="button"
				className="pk-statusbar-item"
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
			</button>

			<DialogRoot
				open={statusOpen}
				onOpenChange={(open) => {
					// Escape in a confirmation can reach this dialog as well; it closes
					// only the confirmation.
					if (!open && confirming) {
						setConfirming(null);
						return;
					}
					setStatusOpen(open);
				}}
			>
				{statusOpen && (
					<Dialog
						testId="dialog-workspace-status"
						title="Your workspace"
						description="What Portikus knows about the machine behind this window."
						onClose={() => setStatusOpen(false)}
					>
						<dl className="grid min-w-0 grid-cols-[max-content_minmax(0,1fr)] gap-x-6 gap-y-1 text-[13px]">
							<dt className="text-ink-muted">State</dt>
							<dd className="m-0" data-testid="workspace-status-state">
								{workspace?.state ?? "connecting"}
							</dd>
							<dt className="text-ink-muted">Desired state</dt>
							<dd className="m-0">{workspace?.desiredState ?? "running"}</dd>
							<dt className="text-ink-muted">Connections</dt>
							<dd className="m-0">{workspace?.activeConnections ?? 0}</dd>
							<dt className="text-ink-muted">Image</dt>
							<dd
								className="m-0 min-w-0 pk-mono-small"
								data-testid="workspace-status-image"
								title={workspace?.imageVersion ?? undefined}
							>
								{shortImage(workspace?.imageVersion ?? null)}
							</dd>
						</dl>
						{workspace?.errorMessage ? (
							<p className="pk-text-body mt-4 text-status-error">
								{workspace.errorMessage}
							</p>
						) : null}
						<WorkspaceControls
							workspaceId={workspaceId}
							workspace={workspace}
							confirming={confirming === "reset-docker" ? null : confirming}
							setConfirming={setConfirming}
						/>
						<StorageSection storage={storage} warning={warning?.detail ?? null} />
						<ResetDocker
							workspaceId={workspaceId}
							workspace={workspace}
							confirming={confirming === "reset-docker"}
							setConfirming={(open) => setConfirming(open ? "reset-docker" : null)}
						/>
						<p
							className="pk-text-small mt-4 mb-0 text-ink-muted"
							data-testid="rebuild-note"
						>
							An administrator can rebuild the workspace system. Your home folder and
							projects are kept; programs installed with sudo apt are not.
						</p>
					</Dialog>
				)}
			</DialogRoot>
		</footer>
	);
}

/**
 * Start, stop and restart from the workspace dialog (SPEC.md §6.2). These
 * only ask the API to change the desired state, so they still work when the
 * workspace itself is hung, which is how a student recovers one.
 */
function WorkspaceControls({
	workspaceId,
	workspace,
	confirming,
	setConfirming,
}: {
	workspaceId: string;
	workspace: Workspace | null;
	confirming: "stop" | "restart" | null;
	setConfirming: (next: "stop" | "restart" | null) => void;
}) {
	const action = useWorkspaceAction(workspaceId);
	const toast = useToast();

	const resolved = workspace ? resolveStatus(workspace) : null;
	// No workspace yet means the presence socket has not reported one.
	const moving = resolved === null || resolved.moving || action.isPending;
	const stopped = workspace?.state === "stopped" || workspace?.state === "error";

	function run(next: "start" | "stop" | "restart") {
		setConfirming(null);
		action.mutate(next, {
			onError: (error) =>
				toast.show({
					tone: "danger",
					title: "The workspace did not change",
					children: error instanceof Error ? error.message : undefined,
				}),
		});
	}

	return (
		<div className="mt-5 flex flex-wrap items-center gap-2">
			{stopped ? (
				<Button
					variant="primary"
					disabled={moving}
					data-testid="workspace-start"
					onClick={() => run("start")}
				>
					Start workspace
				</Button>
			) : (
				<>
					<Button
						disabled={moving}
						data-testid="workspace-restart"
						onClick={() => setConfirming("restart")}
					>
						Restart workspace
					</Button>
					<Button
						disabled={moving}
						data-testid="workspace-stop"
						onClick={() => setConfirming("stop")}
					>
						Stop workspace
					</Button>
				</>
			)}
			{resolved?.moving ? (
				<span
					className="pk-text-small text-ink-muted"
					data-testid="workspace-transition"
				>
					{workspace?.pendingOperation
						? resolved.label
						: `${resolved.label} your workspace.`}
				</span>
			) : null}

			<ConfirmDialogRoot
				open={confirming !== null}
				onOpenChange={(open) => !open && setConfirming(null)}
			>
				{confirming ? (
					<ConfirmDialog
						testId={`dialog-workspace-${confirming}`}
						title={
							confirming === "stop" ? "Stop your workspace?" : "Restart your workspace?"
						}
						description="Programs running in the workspace end. Your files are kept."
						lost={["everything running now, including terminals and servers"]}
						survives={["every file in your home directory"]}
						confirmLabel={
							confirming === "stop" ? "Stop workspace" : "Restart workspace"
						}
						pending={action.isPending}
						onCancel={() => setConfirming(null)}
						onConfirm={() => run(confirming)}
					/>
				) : null}
			</ConfirmDialogRoot>
		</div>
	);
}

/** Used and total for each storage class (SPEC.md §18.3, §19.2). */
function StorageSection({
	storage,
	warning,
}: {
	storage: WorkspaceUsage["storage"] | undefined;
	warning: string | null;
}) {
	return (
		<section className="mt-5" aria-labelledby="workspace-storage-title">
			<h3
				id="workspace-storage-title"
				className="m-0 mb-1 text-sm font-semibold text-ink"
			>
				Storage
			</h3>
			{storage ? (
				<dl className="grid min-w-0 grid-cols-[max-content_minmax(0,1fr)] gap-x-6 gap-y-1 text-[13px]">
					{STORAGE_CLASSES.map((storageClass) => {
						const figure = storage[storageClass];
						const level = storageLevel(figure);
						return (
							<div key={storageClass} className="contents">
								<dt className="text-ink-muted">{STORAGE_LABEL[storageClass]}</dt>
								<dd
									className={`m-0 ${level === "critical" ? "text-status-error" : level === "warning" ? "text-status-warning" : ""}`}
									data-testid={`storage-${storageClass}`}
								>
									{figure
										? `${formatBytes(figure.usedBytes)} of ${formatBytes(figure.totalBytes)}`
										: "Not available"}
								</dd>
							</div>
						);
					})}
				</dl>
			) : (
				<p
					className="pk-text-small m-0 text-ink-muted"
					data-testid="storage-unavailable"
				>
					Available when the workspace is running.
				</p>
			)}
			{warning ? (
				<p className="pk-text-small mt-2 mb-0" data-testid="storage-warning-detail">
					{warning}
				</p>
			) : null}
		</section>
	);
}

/**
 * Reset Docker throws away Docker's storage and keeps everything else
 * (SPEC.md §16.4). The worker stops, resets and restarts the workspace.
 */
function ResetDocker({
	workspaceId,
	workspace,
	confirming,
	setConfirming,
}: {
	workspaceId: string;
	workspace: Workspace | null;
	confirming: boolean;
	setConfirming: (open: boolean) => void;
}) {
	const reset = useResetDocker(workspaceId);
	const busy = !workspace || workspace.pendingOperation !== null || reset.isPending;

	return (
		<div className="mt-4">
			<Button
				disabled={busy}
				data-testid="workspace-reset-docker"
				onClick={() => setConfirming(true)}
			>
				Reset Docker…
			</Button>
			<DialogError error={reset.error} />
			<ConfirmDialogRoot
				open={confirming}
				onOpenChange={(open) => !open && setConfirming(false)}
			>
				{confirming ? (
					<ConfirmDialog
						testId="dialog-reset-docker"
						title="Reset Docker?"
						description="Your workspace stops, Docker's storage is replaced with an empty one, and the workspace starts again if it was running."
						lost={[
							"Docker images",
							"containers",
							"volumes",
							"build cache",
							"programs running now, including terminals and servers",
						]}
						survives={["your projects", "your home folder", "recovery points"]}
						confirmLabel="Reset Docker"
						pending={reset.isPending}
						onCancel={() => setConfirming(false)}
						onConfirm={() => {
							if (reset.isPending) return;
							// An error shows in this dialog: a toast behind it would be hidden.
							reset.mutate(undefined, { onSettled: () => setConfirming(false) });
						}}
					/>
				) : null}
			</ConfirmDialogRoot>
		</div>
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
