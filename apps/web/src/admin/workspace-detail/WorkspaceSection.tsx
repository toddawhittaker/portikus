import type { AdminCapabilities, AdminWorkspaceDetail } from "@portikus/contracts";
import {
	Button,
	Checkbox,
	ConfirmDialog,
	ConfirmDialogRoot,
	useToast,
} from "@portikus/ui";
import { useState } from "react";
import { errorText } from "../../api/request.js";
import { PENDING_LABEL } from "../../shell/StatusBar.js";
import { RestoreFromBackupDialog } from "../backups/BackupDialogs.js";
import { ConfirmByLabelDialog } from "../ConfirmByLabelDialog.js";
import { imageText } from "../markers.js";
import {
	useRebuild,
	useRefreshUsersWhenDone,
	useResetDocker,
	useSetArchived,
} from "../queries.js";
import { NOT_AVAILABLE_TEXT, PANEL_HELP, SECTION_HEADING, WithTip } from "./shared.js";

/** The explanation shown under a Rebuild or Reset Docker button that is off. */
export function capabilityNote(capabilities: AdminCapabilities): string | null {
	if (!capabilities.rebuild && !capabilities.resetDocker) return NOT_AVAILABLE_TEXT;
	if (!capabilities.rebuild) return "Rebuild is not available in this release.";
	if (!capabilities.resetDocker)
		return "Reset Docker is not available in this release.";
	return null;
}

/** Image, Restore from backup and Rebuild (SPEC.md section 20.1). */
export function WorkspaceSection({
	detail,
	ownerName,
}: {
	detail: AdminWorkspaceDetail | null;
	ownerName: string;
}) {
	return (
		<section aria-labelledby="detail-workspace" className="pk-detail-section">
			<h4 id="detail-workspace" className={SECTION_HEADING}>
				{detail ? "Restore and rebuild" : "Workspace"}
			</h4>
			{detail ? (
				<RecoveryActions detail={detail} ownerName={ownerName} />
			) : (
				<p className="pk-text-compact pk-muted m-0">This account has no workspace.</p>
			)}
		</section>
	);
}

function fail(toast: ReturnType<typeof useToast>, title: string) {
	return (error: unknown) =>
		toast.show({ tone: "danger", title, children: errorText(error) });
}

/** Why an operation's button is off: the release lacks it, or another operation is running. */
function useOffReason(detail: AdminWorkspaceDetail) {
	const { workspace } = detail;
	const operationPending = workspace.pendingOperation !== null;
	const noteId = `capability-note-${workspace.id}`;
	const pendingId = `pending-operation-${workspace.id}`;
	return {
		operationPending,
		noteId,
		pendingId,
		offReason: (available: boolean) =>
			[available ? null : noteId, operationPending ? pendingId : null]
				.filter(Boolean)
				.join(" ") || undefined,
	};
}

function RecoveryActions({
	detail,
	ownerName,
}: {
	detail: AdminWorkspaceDetail;
	ownerName: string;
}) {
	const { workspace, capabilities } = detail;
	const toast = useToast();
	const rebuild = useRebuild();
	const [rebuilding, setRebuilding] = useState(false);
	const [preserveDocker, setPreserveDocker] = useState(true);
	const [restoring, setRestoring] = useState<string | null>(null);
	useRefreshUsersWhenDone(workspace.pendingOperation);
	const note = capabilityNote(capabilities);
	const { operationPending, noteId, pendingId, offReason } = useOffReason(detail);
	const rebuildOff = !capabilities.rebuild || operationPending;

	return (
		<>
			<dl className="pk-dl">
				<dt>Image</dt>
				<dd className="pk-mono-small break-all">{imageText(detail.image)}</dd>
			</dl>
			<div className="pk-actions">
				<Button
					size="sm"
					data-testid="detail-restore"
					aria-label={`Restore from backup: ${ownerName}'s workspace`}
					aria-haspopup="dialog"
					onClick={() => setRestoring(workspace.id)}
				>
					Restore from backup
				</Button>
				<WithTip label="Rebuild workspace" tip={PANEL_HELP.rebuild}>
					<Button
						size="sm"
						data-testid="detail-rebuild"
						aria-label={`Rebuild workspace for ${ownerName}`}
						aria-describedby={offReason(capabilities.rebuild)}
						aria-disabled={rebuildOff ? true : undefined}
						aria-haspopup="dialog"
						onClick={() => (rebuildOff ? undefined : setRebuilding(true))}
					>
						Rebuild workspace
					</Button>
				</WithTip>
			</div>
			<RestoreFromBackupDialog
				workspaceId={restoring}
				onClose={() => setRestoring(null)}
			/>
			{workspace.pendingOperation ? (
				<p
					id={pendingId}
					className="pk-text-compact pk-muted m-0"
					data-testid="pending-operation"
				>
					{PENDING_LABEL[workspace.pendingOperation]} Rebuild and Reset Docker are off
					until it finishes.
				</p>
			) : null}
			{note ? (
				<p
					id={noteId}
					className="pk-text-compact pk-muted m-0"
					data-testid="capability-note"
				>
					{note}
				</p>
			) : null}
			<ConfirmByLabelDialog
				open={rebuilding}
				onOpenChange={(open) => (open ? undefined : setRebuilding(false))}
				testId="rebuild-dialog"
				title={`Rebuild ${ownerName}'s workspace?`}
				description="The workspace is recreated from the current image. System packages installed with sudo apt are lost. Projects and home stay."
				confirmLabel="Rebuild"
				label={workspace.label}
				pending={rebuild.isPending}
				onConfirm={() =>
					rebuild.mutate(
						{ workspaceId: workspace.id, resetDocker: !preserveDocker },
						{
							onSuccess: () => {
								toast.show({ tone: "success", title: "Rebuild requested" });
								setRebuilding(false);
							},
							onError: fail(toast, "Could not rebuild the workspace"),
						},
					)
				}
			>
				<Checkbox
					label="Keep Docker images and volumes"
					checked={preserveDocker}
					onChange={(event) => setPreserveDocker(event.target.checked)}
				/>
			</ConfirmByLabelDialog>
		</>
	);
}

/**
 * Reset Docker and Archive, last in the panel and set apart, so a destructive
 * step is never next to a routine one (SPEC.md section 20.1).
 */
export function DestructiveSection({
	detail,
	ownerName,
}: {
	detail: AdminWorkspaceDetail;
	ownerName: string;
}) {
	const { workspace, capabilities } = detail;
	const toast = useToast();
	const resetDocker = useResetDocker();
	const archive = useSetArchived();
	const [dialog, setDialog] = useState<"reset" | "archive" | null>(null);
	const archived = workspace.archivedAt !== null;
	const { operationPending, offReason } = useOffReason(detail);
	const resetOff = !capabilities.resetDocker || operationPending;
	const close = () => setDialog(null);

	function unarchive() {
		if (archive.isPending) return;
		archive.mutate(
			{ workspaceId: workspace.id, archived: false },
			{
				onSuccess: () => toast.show({ tone: "success", title: "Workspace unarchived" }),
				onError: fail(toast, "Could not unarchive the workspace"),
			},
		);
	}

	return (
		<section
			aria-labelledby="detail-destructive"
			className="pk-detail-section"
			data-testid="detail-destructive"
		>
			<h4 id="detail-destructive" className={`${SECTION_HEADING} text-status-danger`}>
				Destructive
			</h4>
			<div className="pk-actions">
				<WithTip label="Reset Docker" tip={PANEL_HELP.resetDocker}>
					<Button
						size="sm"
						variant="danger-secondary"
						data-testid="detail-reset-docker"
						aria-label={`Reset Docker for ${ownerName}`}
						aria-describedby={offReason(capabilities.resetDocker)}
						aria-disabled={resetOff ? true : undefined}
						aria-haspopup="dialog"
						onClick={() => (resetOff ? undefined : setDialog("reset"))}
					>
						Reset Docker
					</Button>
				</WithTip>
				<WithTip label="Archive workspace" tip={archived ? null : PANEL_HELP.archive}>
					<Button
						size="sm"
						variant={archived ? "secondary" : "danger-secondary"}
						data-testid="detail-archive"
						aria-label={`${archived ? "Unarchive" : "Archive"} workspace for ${ownerName}`}
						aria-haspopup={archived ? undefined : "dialog"}
						loading={archived && archive.isPending}
						aria-disabled={archive.isPending ? true : undefined}
						onClick={() => {
							// A second dialog mid-request would only race the first.
							if (archive.isPending) return;
							if (archived) unarchive();
							else setDialog("archive");
						}}
					>
						{archived ? "Unarchive" : "Archive workspace"}
					</Button>
				</WithTip>
			</div>

			<ConfirmDialogRoot
				open={dialog === "archive"}
				onOpenChange={(open) => (open ? undefined : close())}
			>
				<ConfirmDialog
					id="archive-dialog"
					testId="archive-dialog"
					title={`Archive ${ownerName}'s workspace?`}
					description="The workspace stops and cannot be started until it is unarchived. Its files stay where they are."
					confirmLabel="Archive"
					pending={archive.isPending}
					onConfirm={() =>
						archive.mutate(
							{ workspaceId: workspace.id, archived: true },
							{
								onSuccess: () => {
									toast.show({ tone: "success", title: "Workspace archived" });
									close();
								},
								onError: fail(toast, "Could not archive the workspace"),
							},
						)
					}
				/>
			</ConfirmDialogRoot>

			<ConfirmByLabelDialog
				open={dialog === "reset"}
				onOpenChange={(open) => (open ? undefined : close())}
				testId="reset-docker-dialog"
				title={`Reset Docker in ${ownerName}'s workspace?`}
				description="Every Docker image, container and volume in this workspace is deleted. Projects and home stay."
				confirmLabel="Reset Docker"
				label={workspace.label}
				pending={resetDocker.isPending}
				onConfirm={() =>
					resetDocker.mutate(
						{ workspaceId: workspace.id },
						{
							onSuccess: () => {
								toast.show({ tone: "success", title: "Docker reset requested" });
								close();
							},
							onError: fail(toast, "Could not reset Docker"),
						},
					)
				}
			/>
		</section>
	);
}
