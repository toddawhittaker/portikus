import {
	type BackupRequestView,
	type BackupWorkspace,
	type HostBackupSet,
	restoreDirFor,
} from "@portikus/contracts";
import {
	Button,
	ConfirmDialog,
	ConfirmDialogRoot,
	Dialog,
	DialogRoot,
	Select,
} from "@portikus/ui";
import { useState } from "react";
import { ConfirmByLabelDialog } from "../ConfirmByLabelDialog.js";
import { setTime, workspaceName } from "./model.js";

/** What a Delete button asked to delete. */
export type DeleteTarget =
	| { kind: "set"; stamp: string }
	| { kind: "dump"; file: string }
	| { kind: "snapshot"; volume: string; snapshot: string }
	| { kind: "kept"; volume: string; name: string };

function deleteCopy(target: DeleteTarget): { title: string; description: string } {
	switch (target.kind) {
		case "set":
			return {
				title: `Delete the backup set from ${setTime(target.stamp)}?`,
				description:
					"The host removes this set. Workspaces can no longer be restored from it.",
			};
		case "dump":
			return {
				title: `Delete ${target.file}?`,
				description: "The host removes this pre-change database dump.",
			};
		case "snapshot":
			return {
				title: `Delete snapshot ${target.snapshot}?`,
				description: `The snapshot is removed from ${target.volume}. The volume itself does not change.`,
			};
		case "kept":
			return {
				title: `Delete the kept home of ${target.name}?`,
				description:
					"This is the home folder a replace took out of service. Once deleted it cannot be put back.",
			};
	}
}

/** Confirm one delete; the host or the worker carries it out a little later. */
export function DeleteDialog({
	target,
	pending,
	onClose,
	onConfirm,
}: {
	target: DeleteTarget | null;
	pending: boolean;
	onClose: () => void;
	onConfirm: (target: DeleteTarget) => void;
}) {
	const copy = target ? deleteCopy(target) : null;
	return (
		<ConfirmDialogRoot
			open={target !== null}
			onOpenChange={(open) => (open ? undefined : onClose())}
		>
			{target && copy ? (
				<ConfirmDialog
					id="backup-delete-dialog"
					testId="backup-delete-dialog"
					title={copy.title}
					description={copy.description}
					confirmLabel="Delete"
					pending={pending}
					onConfirm={() => onConfirm(target)}
				/>
			) : null}
		</ConfirmDialogRoot>
	);
}

/**
 * Pick a workspace the set covers and restore it into a side copy in that
 * student's home (SPEC.md §24.9; ADR 0040). Nothing is overwritten.
 */
export function RestoreDialog({
	set,
	workspaces,
	pending,
	serverError,
	onClose,
	onRestore,
}: {
	set: HostBackupSet | null;
	workspaces: BackupWorkspace[];
	pending: boolean;
	serverError: string | null;
	onClose: () => void;
	onRestore: (workspaceId: string) => void;
}) {
	const [chosen, setChosen] = useState<string | undefined>(undefined);
	const covered = set
		? workspaces.filter((w) => set.instances.includes(w.instance))
		: [];
	const missing = set ? set.instances.length - covered.length : 0;
	const picked = covered.find((w) => w.id === chosen);
	const stopped = picked !== undefined && picked.state !== "running";
	const folder = set ? restoreDirFor(set.stamp) : "";

	function close() {
		setChosen(undefined);
		onClose();
	}

	return (
		<DialogRoot
			open={set !== null}
			onOpenChange={(open) => (open ? undefined : close())}
		>
			{set ? (
				<Dialog
					testId="backup-restore-dialog"
					title="Restore a workspace"
					description={`From the backup of ${setTime(set.stamp)}. The files are copied into a new folder in the student's home, next to their current files. Nothing is overwritten.`}
					footer={
						<>
							<Button onClick={close}>Cancel</Button>
							<Button
								variant="primary"
								data-testid="backup-restore-confirm"
								loading={pending}
								aria-disabled={!picked || stopped ? true : undefined}
								aria-describedby={stopped ? "backup-restore-stopped" : undefined}
								onClick={() => {
									if (picked && !stopped) onRestore(picked.id);
								}}
							>
								Restore copy
							</Button>
						</>
					}
				>
					<div className="flex flex-col gap-3">
						{covered.length > 0 ? (
							<Select
								id="backup-restore-workspace"
								label="Workspace"
								placeholder="Choose a workspace"
								value={chosen ?? ""}
								onValueChange={setChosen}
								options={covered.map((w) => ({
									value: w.id,
									label: `${workspaceName(w.instance, workspaces)}${w.state === "running" ? "" : `, ${w.state}`}`,
								}))}
							/>
						) : (
							<p className="m-0 text-[13px]" data-testid="backup-restore-none">
								None of the workspaces in this set exist on the platform now.
							</p>
						)}
						{missing > 0 && covered.length > 0 ? (
							<p className="pk-muted m-0 text-[13px]">
								{missing} workspace{missing === 1 ? "" : "s"} in this set no longer
								exist{missing === 1 ? "s" : ""} and cannot be restored here.
							</p>
						) : null}
						<dl className="pk-dl text-[13px]">
							<dt>Copied into</dt>
							<dd className="m-0 font-mono" data-testid="backup-restore-folder">
								~/{folder}
							</dd>
						</dl>
						<p className="pk-muted m-0 text-[13px]">
							The workspace must be running. If the folder already exists, or the home
							does not have room for the copy, the host refuses and nothing changes. The
							student is told when the copy is done.
						</p>
						{stopped ? (
							<p
								id="backup-restore-stopped"
								className="m-0 text-[13px] text-status-warning"
								role="status"
							>
								Start this workspace first. The copy is written by the student's own
								account inside the running workspace.
							</p>
						) : null}
						{serverError ? (
							<p className="m-0 text-[13px] text-status-error" role="alert">
								{serverError}
							</p>
						) : null}
					</div>
				</Dialog>
			) : null}
		</DialogRoot>
	);
}

/**
 * The second step: swap the student's whole home for the one in the set,
 * confirmed by typing the workspace label (SPEC.md §17.2, §24.9; ADR 0040).
 */
export function ReplaceHomeDialog({
	restore,
	workspace,
	pending,
	onClose,
	onConfirm,
}: {
	restore: BackupRequestView | null;
	workspace: BackupWorkspace | undefined;
	pending: boolean;
	onClose: () => void;
	onConfirm: (restoreId: string) => void;
}) {
	const name = workspace?.ownerName ?? "this student";
	const when = restore?.args.stamp ? setTime(restore.args.stamp) : "the backup";
	return (
		<ConfirmByLabelDialog
			open={restore !== null && workspace !== undefined}
			onOpenChange={(open) => (open ? undefined : onClose())}
			testId="backup-replace-dialog"
			title={`Replace ${name}'s home folder?`}
			description={`The whole home folder is replaced with the one in the backup from ${when}. This takes several minutes.`}
			confirmLabel="Replace home"
			label={workspace?.label ?? ""}
			pending={pending}
			onConfirm={() => {
				if (restore) onConfirm(restore.id);
			}}
		>
			<ul className="m-0 list-disc pl-4 text-[13px] text-ink-muted">
				<li>If the workspace is running, it stops, and the student is told why.</li>
				<li>Each active project gets a recovery point first.</li>
				<li>
					The current home folder is kept, and listed under Kept homes below until you
					delete it.
				</li>
				<li>The workspace starts again if it was running.</li>
			</ul>
		</ConfirmByLabelDialog>
	);
}
