import type { Project, RecoveryPoint } from "@portikus/contracts";
import { ConfirmDialog, ConfirmDialogRoot, useToast } from "@portikus/ui";
import { useState } from "react";
import { ApiError } from "../api/request.js";
import { useRestoreRecoveryPoint } from "./queries.js";

/** The point's time in the student's own locale and time zone. */
export function pointTime(createdAt: string): string {
	return new Date(createdAt).toLocaleString(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	});
}

/**
 * Restoring replaces the project's files, so it names the project and the
 * time, and says a point of the current state is made first (SPEC.md §15.8).
 * When that safety point fails because recovery storage is full, a second
 * confirmation offers to restore without it (docs/archive/epics/EPIC-10.md decisions).
 */
export function RestoreConfirm({
	workspaceId,
	project,
	point,
	onClose,
	onRestored,
}: {
	workspaceId: string;
	project: Project;
	point: RecoveryPoint;
	onClose: () => void;
	onRestored: () => void;
}) {
	const restore = useRestoreRecoveryPoint(workspaceId, project.id);
	const toast = useToast();
	const [storageFull, setStorageFull] = useState(false);
	// Shown inside the dialog: a toast behind a modal is hidden from screen readers.
	const [failure, setFailure] = useState<string | null>(null);
	const when = pointTime(point.createdAt);

	function run(skipSafetyPoint: boolean) {
		if (restore.isPending) return;
		setFailure(null);
		restore.mutate(
			{ pointId: point.id, skipSafetyPoint },
			{
				onSuccess: () => {
					toast.show({ tone: "success", title: `${project.name} restored to ${when}` });
					onRestored();
				},
				onError: (error) => {
					if (
						!skipSafetyPoint &&
						error instanceof ApiError &&
						error.code === "STORAGE_FULL"
					) {
						setStorageFull(true);
						return;
					}
					// The server says what happened; a partial restore is not "not restored".
					setFailure(
						error instanceof ApiError
							? error.message
							: "The restore failed. Check your connection and try again.",
					);
				},
			},
		);
	}

	return (
		<ConfirmDialogRoot open onOpenChange={(open) => !open && onClose()}>
			{storageFull ? (
				<ConfirmDialog
					key="storage-full"
					testId="dialog-restore-without-safety"
					title="Restore without saving the current state?"
					description={
						<>
							Recovery storage is full, so Portikus could not save the current files
							first. If you restore now, the current files cannot be brought back.
							<FailureText text={failure} />
						</>
					}
					lost={[`the current files in ${project.name}, with no recovery point`]}
					survives={["folders left out of recovery points, such as node_modules"]}
					confirmLabel="Restore without saving the current state"
					pending={restore.isPending}
					onCancel={onClose}
					onConfirm={() => run(true)}
				/>
			) : (
				<ConfirmDialog
					key="restore"
					testId="dialog-restore-point"
					title={`Restore ${project.name} to ${when}?`}
					description={
						<>
							The current files in ~/projects/{project.slug} are replaced by the files
							from {when}. A recovery point of the current state is made first. Stop
							Claude Code or Codex in this project first. Terminals open in a subfolder
							may need cd again.
							<FailureText text={failure} />
						</>
					}
					lost={[
						"the current files, which are kept in the recovery point made just now",
						"commits made after this time, which are kept in that same point",
					]}
					survives={[
						"folders left out of recovery points, such as node_modules",
						"every other project",
					]}
					confirmLabel="Restore"
					pending={restore.isPending}
					onCancel={onClose}
					onConfirm={() => run(false)}
				/>
			)}
		</ConfirmDialogRoot>
	);
}

/** The error, announced as an alert inside the dialog's description. */
function FailureText({ text }: { text: string | null }) {
	return (
		<span
			role="alert"
			className="mt-2 block text-status-error"
			data-testid="restore-error"
		>
			{text}
		</span>
	);
}
