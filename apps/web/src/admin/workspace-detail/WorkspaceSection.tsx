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

type DialogName = "rebuild" | "reset" | "archive";

/** The explanation shown under a Rebuild or Reset Docker button that is off. */
export function capabilityNote(capabilities: AdminCapabilities): string | null {
	if (!capabilities.rebuild && !capabilities.resetDocker) return NOT_AVAILABLE_TEXT;
	if (!capabilities.rebuild) return "Rebuild is not available in this release.";
	if (!capabilities.resetDocker)
		return "Reset Docker is not available in this release.";
	return null;
}

/** Image, Rebuild, Reset Docker and Archive (SPEC.md section 20.1). */
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
				Workspace
			</h4>
			{detail ? (
				<WorkspaceActions detail={detail} ownerName={ownerName} />
			) : (
				<p className="pk-text-compact pk-muted m-0">This account has no workspace.</p>
			)}
		</section>
	);
}

function WorkspaceActions({
	detail,
	ownerName,
}: {
	detail: AdminWorkspaceDetail;
	ownerName: string;
}) {
	const { workspace, capabilities } = detail;
	const toast = useToast();
	const rebuild = useRebuild();
	const resetDocker = useResetDocker();
	const archive = useSetArchived();
	const [dialog, setDialog] = useState<DialogName | null>(null);
	const [preserveDocker, setPreserveDocker] = useState(true);
	const [restoring, setRestoring] = useState<string | null>(null);
	const archived = workspace.archivedAt !== null;
	// A second request would only answer 409 OPERATION_PENDING (ADR 0021).
	const operationPending = workspace.pendingOperation !== null;
	useRefreshUsersWhenDone(workspace.pendingOperation);
	const note = capabilityNote(capabilities);
	const noteId = `capability-note-${workspace.id}`;

	function fail(title: string) {
		return (error: unknown) =>
			toast.show({ tone: "danger", title, children: errorText(error) });
	}

	const close = () => setDialog(null);
	const rebuildOff = !capabilities.rebuild || operationPending;
	const resetOff = !capabilities.resetDocker || operationPending;
	const pendingId = `pending-operation-${workspace.id}`;
	const offReason = (available: boolean) =>
		[available ? null : noteId, operationPending ? pendingId : null]
			.filter(Boolean)
			.join(" ") || undefined;

	function unarchive() {
		if (archive.isPending) return;
		archive.mutate(
			{ workspaceId: workspace.id, archived: false },
			{
				onSuccess: () => toast.show({ tone: "success", title: "Workspace unarchived" }),
				onError: fail("Could not unarchive the workspace"),
			},
		);
	}

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
					Restore from backup…
				</Button>
				<WithTip label="Rebuild workspace" tip={PANEL_HELP.rebuild}>
					<Button
						size="sm"
						data-testid="detail-rebuild"
						aria-label={`Rebuild workspace for ${ownerName}`}
						aria-describedby={offReason(capabilities.rebuild)}
						aria-disabled={rebuildOff ? true : undefined}
						onClick={() => (rebuildOff ? undefined : setDialog("rebuild"))}
					>
						Rebuild workspace…
					</Button>
				</WithTip>
				<WithTip label="Reset Docker" tip={PANEL_HELP.resetDocker}>
					<Button
						size="sm"
						data-testid="detail-reset-docker"
						aria-label={`Reset Docker for ${ownerName}`}
						aria-describedby={offReason(capabilities.resetDocker)}
						aria-disabled={resetOff ? true : undefined}
						onClick={() => (resetOff ? undefined : setDialog("reset"))}
					>
						Reset Docker…
					</Button>
				</WithTip>
				<WithTip label="Archive workspace" tip={archived ? null : PANEL_HELP.archive}>
					<Button
						size="sm"
						data-testid="detail-archive"
						aria-label={`${archived ? "Unarchive" : "Archive"} workspace for ${ownerName}`}
						loading={archived && archive.isPending}
						aria-disabled={archive.isPending ? true : undefined}
						onClick={() => {
							// A second dialog mid-request would only race the first.
							if (archive.isPending) return;
							if (archived) unarchive();
							else setDialog("archive");
						}}
					>
						{archived ? "Unarchive" : "Archive workspace…"}
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
								onError: fail("Could not archive the workspace"),
							},
						)
					}
				/>
			</ConfirmDialogRoot>

			<ConfirmByLabelDialog
				open={dialog === "rebuild"}
				onOpenChange={(open) => (open ? undefined : close())}
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
								close();
							},
							onError: fail("Could not rebuild the workspace"),
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
							onError: fail("Could not reset Docker"),
						},
					)
				}
			/>
		</>
	);
}
