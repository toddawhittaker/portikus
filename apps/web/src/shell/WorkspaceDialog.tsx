import type { PendingOperation, Workspace, WorkspaceUsage } from "@portikus/contracts";
import {
	Button,
	ConfirmDialog,
	ConfirmDialogRoot,
	Dialog,
	DialogRoot,
	resolveWorkspaceState,
	StateBadge,
	useToast,
} from "@portikus/ui";
import { useState } from "react";
import { useWorkspaceAction } from "../api/workspace.js";
import { DialogError } from "../projects/DialogError.js";
import { useResetDocker } from "../recovery/queries.js";
import { StorageMeters } from "./StorageMeters.js";

/** What the status shows while a maintenance operation waits or runs (SPEC.md §27). */
export const PENDING_LABEL: Record<PendingOperation, string> = {
	"reset-docker": "Resetting Docker…",
	rebuild: "Rebuilding…",
	"rebuild-reset-docker": "Rebuilding…",
};

/** The workspace state, or the pending operation when there is one. */
export function resolveStatus(workspace: Workspace | null): {
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

/** Whether the workspace dialog is open, and whether with Restart's confirmation on top. */
export type WorkspaceDialogMode = "closed" | "open" | "restart";

/** Image fingerprints are 64 characters; a student only ever needs the head of one. */
function shortImage(imageVersion: string | null): string {
	if (!imageVersion) return "—";
	return imageVersion.length > 12 ? `${imageVersion.slice(0, 12)}…` : imageVersion;
}

/**
 * "Your workspace": state and controls first, then storage, Docker, and the
 * technical details folded away (SPEC.md §6.2, §18.3).
 */
export function WorkspaceDialog({
	workspaceId,
	workspace,
	dialog,
	onDialogChange,
	storage,
	warningDetail,
}: {
	workspaceId: string;
	workspace: Workspace | null;
	dialog: WorkspaceDialogMode;
	onDialogChange: (mode: WorkspaceDialogMode) => void;
	storage: WorkspaceUsage["storage"] | undefined;
	warningDetail: string | null;
}) {
	const statusOpen = dialog !== "closed";
	const setStatusOpen = (open: boolean) => onDialogChange(open ? "open" : "closed");
	// The confirmation open on top of the workspace dialog, if any.
	const [chosen, setChosen] = useState<Confirming>(null);
	const confirming: Confirming = dialog === "restart" ? "restart" : chosen;
	const setConfirming = (next: Confirming) => {
		// Leaving the confirmation the page opened keeps the dialog under it.
		if (dialog === "restart") onDialogChange("open");
		setChosen(next);
	};

	return (
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
					<div className="flex flex-col gap-5">
						<WorkspaceControls
							workspaceId={workspaceId}
							workspace={workspace}
							confirming={confirming === "reset-docker" ? null : confirming}
							setConfirming={setConfirming}
						/>
						{workspace?.errorMessage ? (
							<p className="pk-text-body m-0 text-status-error">
								{workspace.errorMessage}
							</p>
						) : null}
						<section
							className="flex flex-col gap-3"
							aria-labelledby="workspace-storage-title"
						>
							<h3 id="workspace-storage-title" className="pk-text-heading m-0">
								Storage
							</h3>
							{storage ? (
								<StorageMeters storage={storage} />
							) : (
								<p
									className="pk-text-small m-0 text-ink-muted"
									data-testid="storage-unavailable"
								>
									Available when the workspace is running.
								</p>
							)}
							{warningDetail ? (
								<p className="pk-text-small m-0" data-testid="storage-warning-detail">
									{warningDetail}
								</p>
							) : null}
						</section>
						<section
							className="flex flex-col items-start gap-2"
							aria-labelledby="workspace-docker-title"
						>
							<h3 id="workspace-docker-title" className="pk-text-heading m-0">
								Docker
							</h3>
							<p className="pk-text-small m-0 text-ink-muted">
								Throws away images, containers and volumes; keeps your projects.
							</p>
							<ResetDocker
								workspaceId={workspaceId}
								workspace={workspace}
								confirming={confirming === "reset-docker"}
								setConfirming={(open) => setConfirming(open ? "reset-docker" : null)}
							/>
						</section>
						<p className="pk-text-small m-0 text-ink-muted" data-testid="rebuild-note">
							An administrator can rebuild the workspace system. Your home folder and
							projects are kept; programs installed with sudo apt are not.
						</p>
						<details data-testid="workspace-status-details">
							<summary className="pk-text-body">Technical details</summary>
							<dl className="pk-techdetail mt-2 grid min-w-0 grid-cols-[max-content_minmax(0,1fr)] gap-x-6 gap-y-1">
								<dt className="text-ink-muted">Desired state</dt>
								<dd className="m-0">{workspace?.desiredState ?? "running"}</dd>
								<dt className="text-ink-muted">Connections</dt>
								<dd className="m-0">{workspace?.activeConnections ?? 0}</dd>
								<dt className="text-ink-muted">Image</dt>
								<dd
									className="m-0 min-w-0"
									data-testid="workspace-status-image"
									title={workspace?.imageVersion ?? undefined}
								>
									{shortImage(workspace?.imageVersion ?? null)}
								</dd>
							</dl>
						</details>
					</div>
				</Dialog>
			)}
		</DialogRoot>
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
		if (moving) return;
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
		<div className="pk-actions">
			{workspace ? (
				<span className="mr-2" data-testid="workspace-status-state">
					<StateBadge
						state={workspace.state}
						desiredState={workspace.desiredState}
						label={workspace.pendingOperation ? resolved?.label : undefined}
						statusRole={false}
					/>
				</span>
			) : (
				<span className="pk-text-body mr-2 text-ink-muted">Connecting</span>
			)}
			{stopped ? (
				<Button
					variant="primary"
					loading={action.isPending}
					aria-disabled={moving ? true : undefined}
					data-testid="workspace-start"
					onClick={() => run("start")}
				>
					Start workspace
				</Button>
			) : (
				<>
					<Button
						aria-disabled={moving ? true : undefined}
						data-testid="workspace-restart"
						onClick={() => (moving ? undefined : setConfirming("restart"))}
					>
						Restart workspace
					</Button>
					<Button
						aria-disabled={moving ? true : undefined}
						data-testid="workspace-stop"
						onClick={() => (moving ? undefined : setConfirming("stop"))}
					>
						Stop workspace
					</Button>
				</>
			)}
			{/* Always mounted, so a new transition is announced inside the dialog. */}
			<span
				className="pk-text-small text-ink-muted"
				role="status"
				data-testid="workspace-transition"
			>
				{resolved?.moving
					? workspace?.pendingOperation
						? resolved.label
						: `${resolved.label} your workspace.`
					: ""}
			</span>

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

/**
 * Reset Docker throws away Docker's storage and keeps everything else
 * (SPEC.md §16.4). The worker stops, resets and restarts the workspace.
 */
export function ResetDocker({
	workspaceId,
	workspace,
	confirming,
	setConfirming,
	label = "Reset Docker…",
	testId = "workspace-reset-docker",
}: {
	workspaceId: string;
	workspace: Workspace | null;
	/** "Clean up Docker…" on the error screen opens the same confirmation. */
	label?: string;
	testId?: string;
	confirming: boolean;
	setConfirming: (open: boolean) => void;
}) {
	const reset = useResetDocker(workspaceId);
	const busy = !workspace || workspace.pendingOperation !== null || reset.isPending;

	return (
		<div className="contents">
			<Button
				loading={reset.isPending}
				aria-disabled={busy ? true : undefined}
				data-testid={testId}
				onClick={() => (busy ? undefined : setConfirming(true))}
			>
				{label}
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
