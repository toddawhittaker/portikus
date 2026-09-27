import type {
	AdminBackups,
	BackupRequestView,
	BackupWorkspace,
	HostBackupSet,
} from "@portikus/contracts";
import { Button, EmptyState, useToast } from "@portikus/ui";
import { type ReactNode, useState } from "react";
import { formatBytes } from "../../monitor/format.js";
import { AdminSection } from "../AdminSection.js";
import { sampleAge } from "../health/HealthTab.js";
import { errorText } from "../SettingsTab.js";
import {
	DeleteDialog,
	type DeleteTarget,
	ReplaceHomeDialog,
	RestoreDialog,
} from "./BackupDialogs.js";
import {
	isWaiting,
	longTime,
	newestCompleteStamp,
	requestText,
	runningText,
	setTime,
	stateText,
	waitingRequest,
	workspaceName,
} from "./model.js";
import {
	useAdminBackups,
	useDeleteDump,
	useDeleteKeptHome,
	useDeleteSet,
	useDeleteSnapshot,
	useReplaceHome,
	useRestoreCopy,
	useRunBackup,
} from "./queries.js";

/** How many recent requests the page lists; the API keeps 50. */
const RECENT_SHOWN = 10;

/** The Backups tab of the admin page (SPEC.md §20.1, §24.9; ADR 0024, ADR 0040). */
export function BackupsTab() {
	const backups = useAdminBackups();
	if (backups.isError) {
		return (
			<AdminSection title="Backups">
				<p className="text-status-error" role="alert">
					{errorText(backups.error)}
				</p>
			</AdminSection>
		);
	}
	if (!backups.data) {
		return (
			<AdminSection title="Backups">
				<div aria-busy="true" data-testid="backups-loading" />
			</AdminSection>
		);
	}
	if (!backups.data.host) {
		return (
			<AdminSection title="Backups">
				<div className="pk-card" data-testid="backups-not-connected">
					<EmptyState icon="info" title="Backups are not connected on this site">
						No backup host has reported to this platform. Backups are taken by a
						separate host that runs the platform; see the Backups section of the
						operations guide.
					</EmptyState>
				</div>
			</AdminSection>
		);
	}
	return <BackupsView data={backups.data} />;
}

type Host = NonNullable<AdminBackups["host"]>;

function BackupsView({ data }: { data: AdminBackups & { host: Host } }) {
	const { host, requests, workspaces } = data;
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
		<AdminSection
			title="Backups"
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
					className="pk-muted m-0 -mt-2 text-right text-[13px]"
					data-testid="backup-run-note"
				>
					{runOffReason}
				</p>
			) : null}
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

			<StatusCard data={data} />

			<SetsSection
				host={host}
				requests={requests}
				onRestore={(set) => {
					setRestoreError(null);
					setRestoring(set);
				}}
				onDelete={setDeleting}
			/>

			<SideCopiesSection
				requests={requests}
				workspaces={workspaces}
				onReplace={setReplacing}
			/>

			<VmSection data={data} onDelete={setDeleting} />

			<DumpsSection host={host} requests={requests} onDelete={setDeleting} />

			<RecentSection requests={requests} workspaces={workspaces} />

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
				onRestore={(workspaceId) => {
					if (!restoring) return;
					setRestoreError(null);
					restore.mutate(
						{ stamp: restoring.stamp, workspaceId },
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

function Card({
	id,
	title,
	children,
	testId,
}: {
	id: string;
	title: string;
	children: ReactNode;
	testId?: string;
}) {
	return (
		<section className="pk-card p-6" aria-labelledby={id} data-testid={testId}>
			<h3 className="pk-text-heading m-0" id={id}>
				{title}
			</h3>
			<div className="mt-4">{children}</div>
		</section>
	);
}

function StatusCard({ data }: { data: AdminBackups & { host: Host } }) {
	const { host } = data;
	return (
		<Card id="backups-status-title" title="Status" testId="backups-status">
			<dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-[13px]">
				<dt className="pk-muted">Host</dt>
				<dd className="m-0" data-testid="backups-host">
					{data.hostReportedAt
						? `${data.hostStale ? "Not reporting" : "Reporting"}, last report ${sampleAge(data.hostReportedAt, Date.now())}`
						: "Not reporting"}
				</dd>
				<dt className="pk-muted">Last run</dt>
				<dd className="m-0" data-testid="backups-last-run">
					{host.lastRun
						? `${host.lastRun.result === "success" ? "Succeeded" : "Failed"}, started ${longTime(host.lastRun.startedAt)}`
						: "None yet"}
				</dd>
				<dt className="pk-muted">Last failure</dt>
				<dd className="m-0" data-testid="backups-last-failure">
					{host.lastFailure
						? `${longTime(host.lastFailure.at)}: ${host.lastFailure.reason}`
						: "None"}
				</dd>
				<dt className="pk-muted">Next scheduled run</dt>
				<dd className="m-0" data-testid="backups-next-run">
					{host.nextRunAt ? longTime(host.nextRunAt) : "Not scheduled"}
				</dd>
				<dt className="pk-muted">Running now</dt>
				<dd className="m-0" data-testid="backups-running">
					{runningText(host.running, data.requests, data.workspaces)}
				</dd>
				<dt className="pk-muted">Restore key</dt>
				<dd className="m-0" data-testid="backups-key">
					{host.keyInstalled
						? "Installed on the host"
						: "Not installed on the host, so workspaces cannot be restored"}
				</dd>
			</dl>
		</Card>
	);
}

/** A table inside a card, with one full-width row when it is empty. */
function Table({
	testId,
	caption,
	headers,
	empty,
	children,
}: {
	testId: string;
	caption: string;
	headers: string[];
	empty: string | null;
	children: ReactNode;
}) {
	return (
		<div className="pk-table-wrap">
			<table className="pk-table" data-testid={testId}>
				<caption className="sr-only">{caption}</caption>
				<thead>
					<tr>
						{headers.map((header) => (
							<th key={header} scope="col">
								{header || <span className="sr-only">Actions</span>}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{empty !== null ? (
						<tr>
							<td colSpan={headers.length} className="pk-cell-muted">
								{empty}
							</td>
						</tr>
					) : (
						children
					)}
				</tbody>
			</table>
		</div>
	);
}

function SetsSection({
	host,
	requests,
	onRestore,
	onDelete,
}: {
	host: Host;
	requests: BackupRequestView[];
	onRestore: (set: HostBackupSet) => void;
	onDelete: (target: DeleteTarget) => void;
}) {
	const newest = newestCompleteStamp(host.sets);
	return (
		<Card id="backups-sets-title" title="Backup sets">
			{!host.keyInstalled ? (
				<p id="backups-key-note" className="pk-muted m-0 mb-3 text-[13px]">
					Restore is off until the restore key is installed on the host.
				</p>
			) : null}
			<Table
				testId="backup-sets"
				caption="Backup sets, newest first"
				headers={["Taken", "Result", "Size", "Workspaces", ""]}
				empty={host.sets.length === 0 ? "No backup sets yet." : null}
			>
				{host.sets.map((set) => {
					const when = setTime(set.stamp);
					const isNewest = set.stamp === newest;
					const deleting = waitingRequest(requests, "delete_set", { stamp: set.stamp });
					const noteId = `backup-set-note-${set.stamp}`;
					return (
						<tr key={set.stamp} data-testid={`backup-set-${set.stamp}`}>
							<th scope="row">{when}</th>
							<td>
								{set.complete ? (
									"Complete"
								) : (
									<span className="pk-tag pk-tag--warning">Incomplete</span>
								)}
								{set.failedVolumes.length > 0 ? (
									<span className="pk-muted">
										{" "}
										{set.failedVolumes.length} volume
										{set.failedVolumes.length === 1 ? "" : "s"} failed
									</span>
								) : null}
								{isNewest ? (
									<span id={noteId} className="pk-muted">
										{" "}
										Newest complete set, always kept
									</span>
								) : null}
							</td>
							<td className="pk-num">{formatBytes(set.sizeBytes)}</td>
							<td className="pk-num">{set.instances.length}</td>
							<td className="pk-cell-actions">
								<div className="flex justify-end gap-2">
									<Button
										size="sm"
										data-testid="backup-set-restore"
										aria-label={`Restore a workspace from ${when}`}
										aria-disabled={
											!host.keyInstalled || set.instances.length === 0
												? true
												: undefined
										}
										aria-describedby={
											!host.keyInstalled ? "backups-key-note" : undefined
										}
										onClick={() => {
											if (host.keyInstalled && set.instances.length > 0) onRestore(set);
										}}
									>
										Restore…
									</Button>
									{deleting ? (
										<span className="pk-muted self-center text-[13px]">Deleting…</span>
									) : (
										<Button
											size="sm"
											data-testid="backup-set-delete"
											aria-label={`Delete the set from ${when}`}
											aria-disabled={isNewest ? true : undefined}
											aria-describedby={isNewest ? noteId : undefined}
											onClick={() => {
												if (!isNewest) onDelete({ kind: "set", stamp: set.stamp });
											}}
										>
											Delete…
										</Button>
									)}
								</div>
							</td>
						</tr>
					);
				})}
			</Table>
		</Card>
	);
}

function copyState(request: BackupRequestView): ReactNode {
	if (request.state === "failed") {
		return (
			<span>
				<span className="pk-tag pk-tag--error">Failed</span>{" "}
				<span className="whitespace-normal">{request.error}</span>
			</span>
		);
	}
	if (request.state === "done") return "Copied";
	return request.state === "claimed" ? "Copying" : "Waiting for the host";
}

function SideCopiesSection({
	requests,
	workspaces,
	onReplace,
}: {
	requests: BackupRequestView[];
	workspaces: BackupWorkspace[];
	onReplace: (restore: BackupRequestView) => void;
}) {
	const copies = requests.filter((r) => r.kind === "restore_copy");
	return (
		<Card id="backups-copies-title" title="Restored copies">
			<p className="pk-muted m-0 mb-3 text-[13px]">
				A copy sits next to the student's files. To swap the whole home folder for it,
				choose Replace home.
			</p>
			<Table
				testId="backup-copies"
				caption="Workspaces restored into a side copy, newest first"
				headers={["Workspace", "From backup", "Folder", "State", ""]}
				empty={copies.length === 0 ? "No workspaces restored recently." : null}
			>
				{copies.map((copy) => {
					const name = workspaceName(copy.args.instance, workspaces);
					const replaceable =
						copy.state === "done" && workspaces.some((w) => w.id === copy.workspaceId);
					return (
						<tr key={copy.id} data-testid="backup-copy">
							<th scope="row">{name}</th>
							<td>{copy.args.stamp ? setTime(copy.args.stamp) : ""}</td>
							<td className="font-mono">~/{copy.args.dir}</td>
							<td>{copyState(copy)}</td>
							<td className="pk-cell-actions">
								{replaceable ? (
									<Button
										size="sm"
										data-testid="backup-copy-replace"
										aria-label={`Replace home for ${name}`}
										onClick={() => onReplace(copy)}
									>
										Replace home…
									</Button>
								) : null}
							</td>
						</tr>
					);
				})}
			</Table>
		</Card>
	);
}

function VmSection({
	data,
	onDelete,
}: {
	data: AdminBackups;
	onDelete: (target: DeleteTarget) => void;
}) {
	const { vm, requests, workspaces } = data;
	const notListed = vm === null ? "Not listed yet." : null;
	return (
		<div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-2">
			<Card id="backups-snapshots-title" title="Pre-change snapshots">
				<Table
					testId="backup-snapshots"
					caption="Pre-change snapshots of workspace volumes"
					headers={["Volume", "Snapshot", "Taken", ""]}
					empty={
						notListed ?? (vm?.snapshots.length ? null : "No pre-change snapshots.")
					}
				>
					{vm?.snapshots.map((snap) => {
						const deleting = waitingRequest(requests, "delete_snapshot", {
							volume: snap.volume,
							snapshot: snap.name,
						});
						return (
							<tr key={`${snap.volume}/${snap.name}`} data-testid="backup-snapshot">
								<td className="font-mono">{snap.volume}</td>
								<th scope="row" className="font-mono">
									{snap.name}
								</th>
								<td>{longTime(snap.createdAt)}</td>
								<td className="pk-cell-actions">
									{deleting ? (
										<span className="pk-muted text-[13px]">Deleting…</span>
									) : (
										<Button
											size="sm"
											data-testid="backup-snapshot-delete"
											aria-label={`Delete snapshot ${snap.name} of ${snap.volume}`}
											onClick={() =>
												onDelete({
													kind: "snapshot",
													volume: snap.volume,
													snapshot: snap.name,
												})
											}
										>
											Delete…
										</Button>
									)}
								</td>
							</tr>
						);
					})}
				</Table>
			</Card>
			<Card id="backups-kept-title" title="Kept homes">
				<Table
					testId="backup-kept-homes"
					caption="Home folders a replace took out of service"
					headers={["Workspace", "Kept since", ""]}
					empty={notListed ?? (vm?.keptHomes.length ? null : "No kept homes.")}
				>
					{vm?.keptHomes.map((kept) => {
						const name = workspaceName(kept.instance, workspaces);
						const deleting = waitingRequest(requests, "delete_kept_home", {
							volume: kept.volume,
						});
						return (
							<tr key={kept.volume} data-testid="backup-kept-home">
								<th scope="row">
									<span className="pk-cell-stack">
										<span>{name}</span>
										<span className="pk-muted font-mono text-[12px]">
											{kept.volume}
										</span>
									</span>
								</th>
								<td>{longTime(kept.createdAt)}</td>
								<td className="pk-cell-actions">
									{deleting ? (
										<span className="pk-muted text-[13px]">Deleting…</span>
									) : (
										<Button
											size="sm"
											data-testid="backup-kept-home-delete"
											aria-label={`Delete the kept home of ${name}`}
											onClick={() =>
												onDelete({ kind: "kept", volume: kept.volume, name })
											}
										>
											Delete…
										</Button>
									)}
								</td>
							</tr>
						);
					})}
				</Table>
			</Card>
		</div>
	);
}

function DumpsSection({
	host,
	requests,
	onDelete,
}: {
	host: Host;
	requests: BackupRequestView[];
	onDelete: (target: DeleteTarget) => void;
}) {
	return (
		<Card id="backups-dumps-title" title="Pre-change database dumps">
			<Table
				testId="backup-dumps"
				caption="Pre-change database dumps on the host"
				headers={["File", "Size", "Taken", ""]}
				empty={host.dumps.length === 0 ? "No pre-change dumps." : null}
			>
				{host.dumps.map((dump) => {
					const deleting = waitingRequest(requests, "delete_dump", { file: dump.file });
					return (
						<tr key={dump.file} data-testid="backup-dump">
							<th scope="row" className="font-mono">
								{dump.file}
							</th>
							<td className="pk-num">{formatBytes(dump.sizeBytes)}</td>
							<td>{longTime(dump.modifiedAt)}</td>
							<td className="pk-cell-actions">
								{deleting ? (
									<span className="pk-muted text-[13px]">Deleting…</span>
								) : (
									<Button
										size="sm"
										data-testid="backup-dump-delete"
										aria-label={`Delete ${dump.file}`}
										onClick={() => onDelete({ kind: "dump", file: dump.file })}
									>
										Delete…
									</Button>
								)}
							</td>
						</tr>
					);
				})}
			</Table>
		</Card>
	);
}

function RecentSection({
	requests,
	workspaces,
}: {
	requests: BackupRequestView[];
	workspaces: BackupWorkspace[];
}) {
	const shown = requests.slice(0, RECENT_SHOWN);
	return (
		<Card id="backups-recent-title" title="Recent requests">
			<Table
				testId="backup-requests"
				caption="Recent backup requests, newest first"
				headers={["Request", "Asked", "State"]}
				empty={shown.length === 0 ? "No requests yet." : null}
			>
				{shown.map((request) => (
					<tr key={request.id} data-testid="backup-request">
						<th scope="row" className="whitespace-normal">
							{requestText(request, workspaces)}
						</th>
						<td>{longTime(request.requestedAt)}</td>
						<td className="whitespace-normal">
							{request.state === "failed" ? (
								<>
									<span className="pk-tag pk-tag--error">Failed</span> {request.error}
								</>
							) : (
								<span className={isWaiting(request) ? "pk-muted" : undefined}>
									{stateText(request)}
								</span>
							)}
						</td>
					</tr>
				))}
			</Table>
		</Card>
	);
}
