import type {
	AdminBackups,
	BackupKeyStatus,
	BackupRequestView,
	HostBackupSet,
} from "@portikus/contracts";
import { Button, EmptyState, Skeleton, useToast } from "@portikus/ui";
import { useState } from "react";
import { errorText } from "../../api/request.js";
import { AdminSection } from "../AdminSection.js";
import { Notice } from "../Notice.js";
import { ActivityGroups } from "./Activity.js";
import {
	DeleteDialog,
	type PendingDelete,
	ReplaceHomeDialog,
	RestoreDialog,
} from "./BackupDialogs.js";
import { BackupKeyPart } from "./BackupKeyPart.js";
import { CleanUpGroup } from "./CleanUp.js";
import { longTime, waitingRequest } from "./model.js";
import { FocusCatchGroup } from "./parts.js";
import {
	useAdminBackups,
	useBackupKey,
	useDeleteBackups,
	useReplaceHome,
	useRestoreCopy,
	useRunBackup,
} from "./queries.js";
import { deleteSelectedId, type ListSelection } from "./SelectBoxes.js";
import { type Host, SetsPart, StatusPart } from "./StatusAndSets.js";
import {
	type DeleteTarget,
	kindsText,
	pickables,
	pickedItems,
	targetKey,
	withKeys,
} from "./selection.js";

const INTRO = {
	id: "admin-backups",
	helpAnchor: "admin-backups",
	text: "Nightly copies of the platform database and of every workspace's home and recovery points, taken by the server itself or by a separate backup host. Docker data is not copied. Restore one person's files into a folder beside their own, then replace their whole home if they need it.",
};

/** The Backups tab of the admin page (SPEC.md §20.1, §24.9; ADR 0024, ADR 0040). */
export function BackupsTab() {
	const backups = useAdminBackups();
	// Answers only on a server that backs itself up and holds its key (ADR 0044).
	const key = useBackupKey().data ?? null;
	if (backups.isError) {
		return (
			<AdminSection title="Backups" intro={INTRO}>
				<p className="text-status-error" role="alert">
					{errorText(backups.error)}
				</p>
			</AdminSection>
		);
	}
	if (!backups.data) {
		return (
			<AdminSection title="Backups" intro={INTRO}>
				<div className="grid gap-6" aria-busy="true" data-testid="backups-loading">
					<Skeleton variant="block" height={200} />
					<Skeleton variant="block" height={120} />
				</div>
			</AdminSection>
		);
	}
	if (!backups.data.host) {
		return (
			<AdminSection title="Backups" intro={INTRO}>
				<div className="pk-card" data-testid="backups-not-connected">
					<EmptyState icon="info" title="Backups are not connected on this site">
						{key
							? "The server's backup service has not reported yet. It reports within a minute of setup; if this stays, see the Backups section of the operations guide."
							: "No backup host has reported to this platform. Backups are taken by a separate host that runs the platform; see the Backups section of the operations guide."}
					</EmptyState>
				</div>
				{key ? <KeyGroup status={key} /> : null}
			</AdminSection>
		);
	}
	return <BackupsView data={backups.data} host={backups.data.host} keyStatus={key} />;
}

function KeyGroup({ status }: { status: BackupKeyStatus }) {
	return (
		<FocusCatchGroup
			id="backups-key-group-title"
			title="Backup key"
			description="The key that unlocks every backup of this server. Keep a copy off the server: copies of the backups kept elsewhere are useless without it."
			testId="backups-key-group"
		>
			<BackupKeyPart status={status} />
		</FocusCatchGroup>
	);
}

function BackupsView({
	data,
	host,
	keyStatus,
}: {
	data: AdminBackups;
	host: Host;
	keyStatus: BackupKeyStatus | null;
}) {
	const { requests, workspaces } = data;
	const toast = useToast();
	const run = useRunBackup();
	const remove = useDeleteBackups();
	const restore = useRestoreCopy();
	const replace = useReplaceHome();
	const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
	const [deleting, setDeleting] = useState<PendingDelete | null>(null);
	const [restoring, setRestoring] = useState<HostBackupSet | null>(null);
	const [restoreError, setRestoreError] = useState<string | null>(null);
	const [replacing, setReplacing] = useState<BackupRequestView | null>(null);

	const backupWaiting = waitingRequest(requests, "backup");
	const runOffReason = data.hostStale
		? "Back up now waits until the host reports again."
		: host.running !== null || backupWaiting
			? "A backup is already waiting or running."
			: null;

	// Rows the host has since removed, or whose delete is now waiting, drop out on their own.
	const items = pickables(data);
	const picked = pickedItems(items, selected);
	const selection: ListSelection = {
		items,
		selected,
		count: picked.length,
		onPick: (keys, on) => setSelected((current) => withKeys(current, keys, on)),
		onDeleteSelected: (listId) =>
			setDeleting({
				targets: picked.map((item) => item.target),
				done: [],
				failed: [],
				selectedAtOpen: picked.length,
				// The button leaves with the selection, so focus falls back to the list's heading.
				returnTo: () =>
					document.getElementById(deleteSelectedId(listId)) ??
					document.getElementById(listId),
			}),
	};

	const announced = deleting ? deleting.selectedAtOpen : picked.length;

	function requested(title: string) {
		return () => toast.show({ tone: "success", title });
	}
	function failed(title: string) {
		return (error: unknown) =>
			toast.show({ tone: "danger", title, children: errorText(error) });
	}

	/** A row's own Delete: that item alone, whatever is ticked. */
	function deleteOne(target: DeleteTarget) {
		setDeleting({
			targets: [target],
			done: [],
			failed: [],
			selectedAtOpen: picked.length,
		});
	}

	function confirmDelete(confirm: PendingDelete) {
		// Clears the last failures, so a retry that fails the same way is new text in the alert.
		setDeleting({ ...confirm, done: [], failed: [] });
		remove.mutate(confirm.targets, {
			onSuccess: ({ done, failed: notDone }) => {
				setSelected((current) => withKeys(current, done.map(targetKey), false));
				if (notDone.length > 0) {
					// Stays open on what is left, which stays ticked.
					setDeleting({
						...confirm,
						targets: notDone.map((failure) => failure.target),
						done,
						failed: notDone,
					});
					return;
				}
				requested(
					done.length === 1
						? "Delete requested"
						: `Delete requested for ${kindsText(done)}`,
				)();
				setDeleting(null);
			},
		});
	}

	return (
		<AdminSection title="Backups" intro={INTRO}>
			{data.hostStale && data.hostReportedAt ? (
				<Notice tone="warning" testId="backups-host-stale">
					<strong>
						The host has not reported since {longTime(data.hostReportedAt)}.
					</strong>{" "}
					The page shows what it last said. Requests wait until it reports again.
				</Notice>
			) : null}

			<FocusCatchGroup
				id="backups-sets-group-title"
				title="Status and sets"
				actions={
					<Button
						variant="primary"
						data-testid="backup-run"
						loading={run.isPending}
						aria-disabled={runOffReason ? true : undefined}
						aria-describedby={runOffReason ? "backup-run-note" : undefined}
						onClick={() => {
							if (runOffReason || run.isPending) return;
							run.mutate(undefined, {
								onSuccess: requested("Backup requested"),
								onError: failed("Could not start a backup"),
							});
						}}
					>
						Back up now
					</Button>
				}
			>
				{runOffReason ? (
					<p
						id="backup-run-note"
						className="pk-muted m-0 text-[13px]"
						data-testid="backup-run-note"
					>
						{runOffReason}
					</p>
				) : null}
				<StatusPart data={data} host={host} local={keyStatus !== null} />
				<SetsPart
					host={host}
					requests={requests}
					onRestore={(set) => {
						setRestoreError(null);
						setRestoring(set);
					}}
					onDelete={deleteOne}
					selection={selection}
				/>
			</FocusCatchGroup>

			{keyStatus ? <KeyGroup status={keyStatus} /> : null}

			<ActivityGroups
				requests={requests}
				workspaces={workspaces}
				onReplace={setReplacing}
			/>

			<CleanUpGroup
				data={data}
				host={host}
				onDelete={deleteOne}
				selection={selection}
			/>

			{/* Stays mounted, so each new count is read out. It holds still while the
			    confirm is open, so a partial failure is announced once, by the dialog's alert. */}
			<span className="sr-only" aria-live="polite" data-testid="backup-selected-count">
				{announced > 0 ? `${announced} selected` : ""}
			</span>
			<DeleteDialog
				confirm={deleting}
				pending={remove.isPending}
				onClose={() => setDeleting(null)}
				onConfirm={confirmDelete}
			/>
			<RestoreDialog
				set={restoring}
				workspaces={workspaces}
				pending={restore.isPending}
				serverError={restoreError}
				onClose={() => setRestoring(null)}
				onRestore={(workspaceId, stamp) => {
					setRestoreError(null);
					restore.mutate(
						{ stamp, workspaceId },
						{
							onSuccess: () => {
								requested("Restore requested")();
								setRestoring(null);
							},
							onError: (error) => setRestoreError(errorText(error)),
						},
					);
				}}
			/>
			<ReplaceHomeDialog
				restore={replacing}
				workspace={workspaces.find((w) => w.id === replacing?.workspaceId)}
				pending={replace.isPending}
				onClose={() => setReplacing(null)}
				onConfirm={(restoreId) =>
					replace.mutate(restoreId, {
						onSuccess: () => {
							requested("Home replace requested")();
							setReplacing(null);
						},
						onError: failed("Could not replace the home folder"),
					})
				}
			/>
		</AdminSection>
	);
}
