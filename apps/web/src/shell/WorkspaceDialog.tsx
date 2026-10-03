import type { PendingOperation, Workspace, WorkspaceUsage } from "@portikus/contracts";
import {
	Button,
	ConfirmDialog,
	ConfirmDialogRoot,
	Dialog,
	DialogRoot,
	Icon,
	resolveWorkspaceState,
	StateBadge,
	Toggletip,
	useToast,
} from "@portikus/ui";
import { useState } from "react";
import { errorText } from "../api/request.js";
import { useWorkspaceAction } from "../api/workspace.js";
import { DialogError } from "../common/DialogError.js";
import { useResetDocker } from "../recovery/queries.js";
import { KeepRunningSection } from "./KeepRunning.js";
import { StorageMeters } from "./StorageMeters.js";

/** What the status shows while a maintenance operation waits or runs (SPEC.md §27). */
export const PENDING_LABEL: Record<PendingOperation, string> = {
	"reset-docker": "Resetting Docker…",
	rebuild: "Rebuilding…",
	"rebuild-reset-docker": "Rebuilding…",
	"replace-home": "Replacing home folder…",
};

/** Why the state carries an "unconfirmed" marker (SPEC.md §18.3). */
export const UNVERIFIED_EXPLANATION =
	"Portikus can't reach the workspace host right now, so this may be out of date.";

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
	const resetDocker = useResetDocker(workspaceId);
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
						{workspace && !workspace.stateVerified ? (
							<p
								className="pk-text-body pk-tone-warning m-0 flex items-center gap-2"
								data-testid="workspace-status-unverified"
							>
								<Icon name="alert" size="sm" />
								{UNVERIFIED_EXPLANATION}
							</p>
						) : null}
						{workspace?.errorMessage ? (
							<p className="pk-text-body m-0 text-status-error">
								{workspace.errorMessage}
							</p>
						) : null}
						{workspace?.state === "running" ? (
							<KeepRunningSection workspaceId={workspaceId} workspace={workspace} />
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
									className="pk-text-compact m-0 text-ink-muted"
									data-testid="storage-unavailable"
								>
									Available when the workspace is running.
								</p>
							)}
							{warningDetail ? (
								<p className="pk-text-compact m-0" data-testid="storage-warning-detail">
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
							<div className="flex items-center gap-1">
								<ResetDocker
									workspace={workspace}
									confirming={confirming === "reset-docker"}
									setConfirming={(open) => setConfirming(open ? "reset-docker" : null)}
									reset={resetDocker}
								/>
								<Toggletip label="Reset Docker">
									Deletes your Docker images, containers, volumes and build cache to
									free space. Your projects, home folder and recovery points are kept.
									You pull or build images again afterwards.
								</Toggletip>
							</div>
							<DialogError error={resetDocker.error} />
						</section>
						<section
							className="flex flex-col gap-2"
							aria-labelledby="workspace-rebuild-title"
						>
							<h3 id="workspace-rebuild-title" className="pk-text-heading m-0">
								Rebuilds
							</h3>
							<p
								className="pk-text-compact m-0 text-ink-muted"
								data-testid="rebuild-note"
							>
								An administrator can rebuild the workspace system. Your home folder and
								projects are kept; programs installed with sudo apt are not.
							</p>
						</section>
						<details className="group" data-testid="workspace-status-details">
							<TechnicalSummary />
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

	const transition = resolved?.moving
		? workspace?.pendingOperation
			? resolved.label
			: `${resolved.label} your workspace.`
		: "";

	function run(next: "start" | "stop" | "restart") {
		setConfirming(null);
		if (moving) return;
		action.mutate(next, {
			onError: (error) =>
				toast.show({
					tone: "danger",
					title: "The workspace did not change",
					children: errorText(error, "Something went wrong. Try again."),
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
						moving={workspace.pendingOperation !== null}
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
					<Toggletip label="Restart workspace">
						Stops and starts the machine behind this window. Your files are kept and
						your file tabs reopen. Terminals and programs running now end, and previews
						come back inactive.
					</Toggletip>
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
				className="pk-text-compact text-ink-muted"
				role="status"
				data-testid="workspace-transition"
			>
				{transition}
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
						// Opened while the state settles (the throttle notice can): wait, say why.
						disabled={moving && !action.isPending}
						onCancel={() => setConfirming(null)}
						disabledReason={
							<span data-testid="workspace-confirm-wait">
								{transition || "Connecting."} You can {confirming} once it has finished.
							</span>
						}
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
	workspace,
	confirming,
	setConfirming,
	primary = false,
	testId = "workspace-reset-docker",
	reset,
}: {
	workspace: Workspace | null;
	/** The error screen makes it the main action when Docker filled the storage. */
	primary?: boolean;
	testId?: string;
	confirming: boolean;
	setConfirming: (open: boolean) => void;
	/** The caller owns the request so it can show the error where it fits. */
	reset: ReturnType<typeof useResetDocker>;
}) {
	const busy = !workspace || workspace.pendingOperation !== null || reset.isPending;

	return (
		<div className="contents">
			<Button
				variant={primary ? "primary" : "secondary"}
				loading={reset.isPending}
				aria-disabled={busy ? true : undefined}
				data-testid={testId}
				onClick={() => (busy ? undefined : setConfirming(true))}
			>
				Reset Docker…
			</Button>
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
							// The caller shows an error next to the button: a toast behind a dialog would be hidden.
							reset.mutate(undefined, { onSettled: () => setConfirming(false) });
						}}
					/>
				) : null}
			</ConfirmDialogRoot>
		</div>
	);
}

/** A summary with the system's chevron instead of the browser's triangle. */
export function TechnicalSummary() {
	return (
		<summary className="pk-text-body pk-summary inline-flex cursor-pointer list-none items-center gap-1 [&::-webkit-details-marker]:hidden">
			<Icon name="chevron-right" size="md" className="group-open:rotate-90" />
			Technical details
		</summary>
	);
}
