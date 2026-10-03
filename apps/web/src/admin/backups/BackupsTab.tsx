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
import { ActivityGroups } from "./Activity.js";
import {
	DeleteDialog,
	type DeleteTarget,
	ReplaceHomeDialog,
	RestoreDialog,
} from "./BackupDialogs.js";
import { BackupKeyPart } from "./BackupKeyPart.js";
import { CleanUpGroup } from "./CleanUp.js";
import { longTime, waitingRequest } from "./model.js";
import { Group } from "./parts.js";
import {
	useAdminBackups,
	useBackupKey,
	useDeleteDump,
	useDeleteKeptHome,
	useDeleteSet,
	useDeleteSnapshot,
	useReplaceHome,
	useRestoreCopy,
	useRunBackup,
} from "./queries.js";
import { type Host, SetsPart, StatusPart } from "./StatusAndSets.js";

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
		<Group
			id="backups-key-group-title"
			title="Backup key"
			description="The key that unlocks every backup of this server. Keep a copy off the server: copies of the backups kept elsewhere are useless without it."
			testId="backups-key-group"
		>
			<BackupKeyPart status={status} />
		</Group>
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
	const deleteSet = useDeleteSet();
	const deleteDump = useDeleteDump();
	const deleteSnapshot = useDeleteSnapshot();
	const deleteKept = useDeleteKeptHome();
	const restore = useRestoreCopy();
	const replace = useReplaceHome();
	const [deleting, setDeleting] = useState<DeleteTarget | null>(null);
	const [restoring, setRestoring] = useState<HostBackupSet | null>(null);
	const [restoreError, setRestoreError] = useState<string | null>(null);
	const [replacing, setReplacing] = useState<BackupRequestView | null>(null);

	const backupWaiting = waitingRequest(requests, "backup");
	const runOffReason = data.hostStale
		? "Back up now waits until the host reports again."
		: host.running !== null || backupWaiting
			? "A backup is already waiting or running."
			: null;
	const deletePending =
		deleteSet.isPending ||
		deleteDump.isPending ||
		deleteSnapshot.isPending ||
		deleteKept.isPending;

	function requested(title: string) {
		return () => toast.show({ tone: "success", title });
	}
	function failed(title: string) {
		return (error: unknown) =>
			toast.show({ tone: "danger", title, children: errorText(error) });
	}

	function confirmDelete(target: DeleteTarget) {
		const options = {
			onSuccess: () => {
				requested("Delete requested")();
				setDeleting(null);
			},
			onError: failed("Could not request the delete"),
		};
		if (target.kind === "set") deleteSet.mutate(target.stamp, options);
		else if (target.kind === "dump") deleteDump.mutate(target.file, options);
		else if (target.kind === "snapshot") deleteSnapshot.mutate(target, options);
		else deleteKept.mutate(target.volume, options);
	}

	return (
		<AdminSection title="Backups" intro={INTRO}>
			{data.hostStale && data.hostReportedAt ? (
				<div
					className="pk-card border-status-warning bg-status-warning-soft p-4 text-status-warning"
					data-testid="backups-host-stale"
				>
					<strong>
						The host has not reported since {longTime(data.hostReportedAt)}.
					</strong>{" "}
					The page shows what it last said. Requests wait until it reports again.
				</div>
			) : null}

			<Group
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
					onDelete={setDeleting}
				/>
			</Group>

			{keyStatus ? <KeyGroup status={keyStatus} /> : null}

			<ActivityGroups
				requests={requests}
				workspaces={workspaces}
				onReplace={setReplacing}
			/>

			<CleanUpGroup data={data} host={host} onDelete={setDeleting} />

			<DeleteDialog
				target={deleting}
				pending={deletePending}
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
