import type {
	AdminBackups,
	BackupKeyStatus,
	BackupRequestView,
	BackupWorkspace,
	HostBackupSet,
} from "@portikus/contracts";
import { Button, EmptyState, Skeleton, Toggletip, useToast } from "@portikus/ui";
import {
	type FocusEvent,
	Fragment,
	type ReactNode,
	type RefObject,
	useEffect,
	useRef,
	useState,
} from "react";
import { errorText } from "../../api/request.js";
import { formatBytes } from "../../monitor/format.js";
import { plural } from "../../text.js";
import { AdminSection } from "../AdminSection.js";
import { sampleAge } from "../health/HealthTab.js";
import {
	DeleteDialog,
	type DeleteTarget,
	ReplaceHomeDialog,
	RestoreDialog,
} from "./BackupDialogs.js";
import { BackupKeyPart } from "./BackupKeyPart.js";
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
	useBackupKey,
	useDeleteDump,
	useDeleteKeptHome,
	useDeleteSet,
	useDeleteSnapshot,
	useReplaceHome,
	useRestoreCopy,
	useRunBackup,
} from "./queries.js";

const INTRO = {
	id: "admin-backups",
	helpAnchor: "admin-backups",
	text: "Nightly copies of the platform database and of every workspace's home and recovery points, taken by the server itself or by a separate backup host. Docker data is not copied. Restore one person's files into a folder beside their own, then replace their whole home if they need it.",
};

/** How many recent requests the page lists; the API keeps 50. */
const RECENT_SHOWN = 10;

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

type Host = NonNullable<AdminBackups["host"]>;

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

			<RestoresGroup
				requests={requests}
				workspaces={workspaces}
				onReplace={setReplacing}
			/>

			<CleanUpGroup data={data} host={host} onDelete={setDeleting} />

			<RecentGroup requests={requests} workspaces={workspaces} />

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

/**
 * Catches focus when a finished delete removes the focused row, such as its
 * Deleting button, and puts it on `heading` instead.
 */
function useFocusCatch(heading: RefObject<HTMLElement | null>) {
	const focused = useRef<HTMLElement | null>(null);
	useEffect(() => {
		const last = focused.current;
		if (!last || last.isConnected) return;
		focused.current = null;
		const active = document.activeElement;
		if (active === null || active === document.body) heading.current?.focus();
	});
	return (event: FocusEvent<HTMLElement>) => {
		focused.current = event.target;
	};
}

/** One of the page's h3 groups, drawn as a card. */
function Group({
	id,
	title,
	help,
	description,
	actions,
	children,
	testId,
}: {
	id: string;
	title: string;
	help?: ReactNode;
	description?: string;
	actions?: ReactNode;
	children: ReactNode;
	testId?: string;
}) {
	const heading = useRef<HTMLHeadingElement>(null);
	const onFocus = useFocusCatch(heading);
	return (
		<section
			className="pk-card @container grid gap-5 p-6"
			aria-labelledby={id}
			data-testid={testId}
			onFocus={onFocus}
		>
			<div className="flex flex-wrap items-start gap-x-4 gap-y-2">
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-1">
						<h3 className="pk-text-heading m-0" id={id} ref={heading} tabIndex={-1}>
							{title}
						</h3>
						{help}
					</div>
					{description ? (
						<p className="pk-muted mt-1 mb-0 text-[13px]">{description}</p>
					) : null}
				</div>
				{actions}
			</div>
			{children}
		</section>
	);
}

/** A titled part inside a group, with an h4. */
function Part({
	id,
	title,
	help,
	children,
	testId,
}: {
	id: string;
	title: string;
	help?: ReactNode;
	children: ReactNode;
	testId?: string;
}) {
	const heading = useRef<HTMLHeadingElement>(null);
	const onFocus = useFocusCatch(heading);
	return (
		<section
			className="grid gap-3"
			aria-labelledby={id}
			data-testid={testId}
			onFocus={onFocus}
		>
			<div className="flex items-center gap-1">
				<h4
					className="pk-text-compact m-0 font-semibold text-ink-muted"
					id={id}
					ref={heading}
					tabIndex={-1}
				>
					{title}
				</h4>
				{help}
			</div>
			{children}
		</section>
	);
}

function StatusPart({
	data,
	host,
	local,
}: {
	data: AdminBackups;
	host: Host;
	/** The server backs itself up, so "the host" is this server. */
	local: boolean;
}) {
	return (
		<Part id="backups-status-title" title="Status" testId="backups-status">
			{/* Pairs sit side by side once the card is wide enough. */}
			<dl className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-6 gap-y-2 text-[13px] @3xl:grid-cols-[max-content_minmax(0,1fr)_max-content_minmax(0,1fr)]">
				<dt className="pk-muted">Host</dt>
				<dd className="m-0" data-testid="backups-host">
					{data.hostReportedAt
						? `${data.hostStale ? "Not reporting" : "Reporting"}, last report ${sampleAge(data.hostReportedAt, Date.now())}`
						: "Not reporting"}
				</dd>
				<dt className="pk-muted">Running now</dt>
				<dd className="m-0" data-testid="backups-running">
					{runningText(host.running, data.requests, data.workspaces)}
				</dd>
				<dt className="pk-muted">Last run</dt>
				<dd className="m-0" data-testid="backups-last-run">
					{host.lastRun
						? `${host.lastRun.result === "success" ? "Succeeded" : "Failed"}, started ${longTime(host.lastRun.startedAt)}`
						: "None yet"}
				</dd>
				<dt className="pk-muted">Next scheduled run</dt>
				<dd className="m-0" data-testid="backups-next-run">
					{host.nextRunAt ? longTime(host.nextRunAt) : "Not scheduled"}
				</dd>
				<dt className="pk-muted">Last failure</dt>
				<dd className="m-0 [overflow-wrap:anywhere]" data-testid="backups-last-failure">
					{host.lastFailure
						? `${longTime(host.lastFailure.at)}: ${host.lastFailure.reason}`
						: "None"}
				</dd>
				<dt className="pk-muted flex items-center gap-1">
					Restore key
					<Toggletip label="the restore key">
						The private key that unlocks backups, kept on{" "}
						{local ? "this server" : "the backup host"}. Without it, backups still run,
						but nothing can be restored.
					</Toggletip>
				</dt>
				<dd className="m-0" data-testid="backups-key">
					{host.keyInstalled
						? `Installed on ${local ? "this server" : "the host"}`
						: `Not installed on ${local ? "this server" : "the host"}, so workspaces cannot be restored`}
				</dd>
			</dl>
		</Part>
	);
}

/** A table, or one line of text in its place when there is nothing to list. */
function Table({
	testId,
	caption,
	headers,
	empty,
	children,
}: {
	testId: string;
	caption: string;
	/** Column names; "" for the actions column, or a name with its toggletip. */
	headers: (string | { name: string; help: ReactNode })[];
	empty: string | null;
	children: ReactNode;
}) {
	if (empty !== null) {
		return (
			<p className="pk-muted m-0 text-[13px]" data-testid={`${testId}-empty`}>
				{empty}
			</p>
		);
	}
	return (
		<div className="pk-table-wrap">
			<table className="pk-table" data-testid={testId}>
				<caption className="sr-only">{caption}</caption>
				<thead>
					<tr>
						{headers.map((header) =>
							typeof header === "string" ? (
								<th key={header} scope="col">
									{header || <span className="sr-only">Actions</span>}
								</th>
							) : (
								<th key={header.name} scope="col">
									<span className="inline-flex items-center gap-1">
										{header.name}
										{header.help}
									</span>
								</th>
							),
						)}
					</tr>
				</thead>
				<tbody>{children}</tbody>
			</table>
		</div>
	);
}

function SetsPart({
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
		<Part id="backups-sets-title" title="Backup sets">
			{!host.keyInstalled ? (
				<p id="backups-key-note" className="pk-muted m-0 text-[13px]">
					Restore is off until the restore key is installed on the host.
				</p>
			) : null}
			<Table
				testId="backup-sets"
				caption="Backup sets, newest first"
				headers={[
					{
						name: "Taken",
						help: (
							<Toggletip label="set times">
								Set times are in UTC, because the restore folder is named with them.
							</Toggletip>
						),
					},
					{
						name: "Result",
						help: (
							<Toggletip label="incomplete sets">
								Incomplete means some volumes failed to copy in that run. You can still
								restore a workspace from it, but its copy may lack what failed.
							</Toggletip>
						),
					},
					"Size",
					"Workspaces",
					"",
				]}
				empty={host.sets.length === 0 ? "No backup sets yet." : null}
			>
				{host.sets.map((set) => (
					<SetRow
						key={set.stamp}
						set={set}
						keyInstalled={host.keyInstalled}
						isNewest={set.stamp === newest}
						deleting={
							waitingRequest(requests, "delete_set", { stamp: set.stamp }) !== undefined
						}
						onRestore={onRestore}
						onDelete={onDelete}
					/>
				))}
			</Table>
		</Part>
	);
}

/** The notes after a set's result, joined with ". " so each gets one stop when read aloud. */
function setNotes(
	set: HostBackupSet,
	keyInstalled: boolean,
	isNewest: boolean,
): { key: string; node: ReactNode }[] {
	const notes: { key: string; node: ReactNode }[] = [];
	if (set.verified === false && keyInstalled) {
		notes.push({
			key: "tag",
			node: <span className="pk-tag pk-tag--warning">Not verified</span>,
		});
		notes.push({
			key: "unverified",
			node: (
				<span id={`backup-set-unverified-${set.stamp}`} className="pk-muted">
					This server's key did not make this set, so it cannot be restored
				</span>
			),
		});
	}
	if (set.instances.length === 0) {
		notes.push({
			key: "empty",
			node: (
				<span id={`backup-set-empty-${set.stamp}`} className="pk-muted">
					No workspaces to restore from this set
				</span>
			),
		});
	}
	if (isNewest) {
		notes.push({
			key: "newest",
			node: (
				<span id={`backup-set-note-${set.stamp}`} className="pk-muted">
					The newest complete set is always kept
				</span>
			),
		});
	}
	return notes;
}

/** Which note explains why a set's Restore button is off, if it is. */
function setRestoreBlockerId(
	set: HostBackupSet,
	keyInstalled: boolean,
): string | undefined {
	if (!keyInstalled) return "backups-key-note";
	// Absent from an older host, which does not check sets.
	if (set.verified === false) return `backup-set-unverified-${set.stamp}`;
	if (set.instances.length === 0) return `backup-set-empty-${set.stamp}`;
	return undefined;
}

function SetResult({
	set,
	notes,
}: {
	set: HostBackupSet;
	notes: { key: string; node: ReactNode }[];
}) {
	return (
		<>
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
			{set.skippedVolumes ? (
				<span className="pk-muted" data-testid={`backup-set-skipped-${set.stamp}`}>
					{" "}
					{set.skippedVolumes} volume
					{set.skippedVolumes === 1 ? "" : "s"} of no workspace skipped
				</span>
			) : null}
			{notes.map((note) => (
				<Fragment key={note.key}>
					{". "}
					{note.node}
				</Fragment>
			))}
			{notes.length > 0 ? "." : null}
		</>
	);
}

function SetRow({
	set,
	keyInstalled,
	isNewest,
	deleting,
	onRestore,
	onDelete,
}: {
	set: HostBackupSet;
	keyInstalled: boolean;
	isNewest: boolean;
	deleting: boolean;
	onRestore: (set: HostBackupSet) => void;
	onDelete: (target: DeleteTarget) => void;
}) {
	const when = setTime(set.stamp);
	const noteId = `backup-set-note-${set.stamp}`;
	const restoreOff =
		!keyInstalled || set.verified === false || set.instances.length === 0;
	return (
		<tr data-testid={`backup-set-${set.stamp}`}>
			<th scope="row">{when}</th>
			<td>
				<SetResult set={set} notes={setNotes(set, keyInstalled, isNewest)} />
			</td>
			<td className="tabular-nums">{formatBytes(set.sizeBytes)}</td>
			<td className="tabular-nums">{set.instances.length}</td>
			<td className="pk-cell-actions">
				<div className="flex justify-end gap-2">
					<Button
						size="sm"
						data-testid="backup-set-restore"
						aria-label={`Restore a workspace from ${when}`}
						aria-disabled={restoreOff ? true : undefined}
						aria-describedby={setRestoreBlockerId(set, keyInstalled)}
						onClick={() => {
							if (!restoreOff) onRestore(set);
						}}
					>
						Restore…
					</Button>
					{/* Stays mounted while deleting so focus is not lost. */}
					<Button
						size="sm"
						data-testid="backup-set-delete"
						aria-label={
							deleting ? `Deleting the set from ${when}` : `Delete the set from ${when}`
						}
						aria-disabled={isNewest || deleting ? true : undefined}
						aria-describedby={isNewest ? noteId : undefined}
						onClick={() => {
							if (!isNewest && !deleting) onDelete({ kind: "set", stamp: set.stamp });
						}}
					>
						{deleting ? "Deleting…" : "Delete…"}
					</Button>
				</div>
			</td>
		</tr>
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

function RestoresGroup({
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
		<Group
			id="backups-restores-title"
			title="Restores"
			help={
				<Toggletip label="Replace home">
					Replace home swaps the student's whole home folder for the one in the same
					backup set. You confirm by typing the workspace label. Their current home is
					kept, and listed under Clean up until you delete it.
				</Toggletip>
			}
			description="Each restored copy sits next to the student's files. To swap their whole home folder for the one in the same backup set, choose Replace home."
			testId="backups-restores"
		>
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
		</Group>
	);
}

/**
 * Snapshots, kept homes and dumps, which only need a look now and then, so the
 * group is closed while all three are empty.
 */
function CleanUpGroup({
	data,
	host,
	onDelete,
}: {
	data: AdminBackups;
	host: Host;
	onDelete: (target: DeleteTarget) => void;
}) {
	const { vm } = data;
	const dumps = plural(host.dumps.length, "dump");
	const summary = vm
		? `${plural(vm.snapshots.length, "snapshot")}, ${plural(vm.keptHomes.length, "kept home")}, ${dumps}`
		: `${dumps}; snapshots and kept homes not listed yet`;
	const anything =
		host.dumps.length > 0 ||
		(vm !== null && vm.snapshots.length + vm.keptHomes.length > 0);
	// Opened once from what is there; after that the admin's toggle stands.
	const [open] = useState(anything);
	const summaryRef = useRef<HTMLElement>(null);
	const onFocus = useFocusCatch(summaryRef);
	return (
		<section
			className="pk-card p-6"
			aria-labelledby="backups-cleanup-title"
			data-testid="backups-cleanup"
			onFocus={onFocus}
		>
			<details open={open}>
				<summary
					ref={summaryRef}
					className="pk-focus-ring w-fit cursor-pointer rounded-xs"
					data-testid="backups-cleanup-summary"
				>
					<h3 className="pk-text-heading m-0 inline" id="backups-cleanup-title">
						Clean up
					</h3>
					<span className="pk-muted text-[13px]">: {summary}</span>
				</summary>
				<div className="mt-6 grid gap-6">
					<VmParts data={data} onDelete={onDelete} />
					<DumpsPart host={host} requests={data.requests} onDelete={onDelete} />
				</div>
			</details>
		</section>
	);
}

function VmParts({
	data,
	onDelete,
}: {
	data: AdminBackups;
	onDelete: (target: DeleteTarget) => void;
}) {
	const { vm, requests, workspaces } = data;
	const notListed = vm === null ? "Not listed yet." : null;
	return (
		<>
			<Part
				id="backups-snapshots-title"
				title="Pre-change snapshots"
				help={
					<Toggletip label="pre-change snapshots">
						Snapshots of workspace volumes, named pre-something, that the operator takes
						before a risky change such as a rebuild on a new image. Nothing deletes them
						on its own. Delete them once the change checks out.
					</Toggletip>
				}
			>
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
									<Button
										size="sm"
										data-testid="backup-snapshot-delete"
										aria-label={
											deleting
												? `Deleting snapshot ${snap.name} of ${snap.volume}`
												: `Delete snapshot ${snap.name} of ${snap.volume}`
										}
										aria-disabled={deleting ? true : undefined}
										onClick={() => {
											if (!deleting)
												onDelete({
													kind: "snapshot",
													volume: snap.volume,
													snapshot: snap.name,
												});
										}}
									>
										{deleting ? "Deleting…" : "Delete…"}
									</Button>
								</td>
							</tr>
						);
					})}
				</Table>
			</Part>
			<Part
				id="backups-kept-title"
				title="Kept homes"
				help={
					<Toggletip label="kept homes">
						A student's previous home folder, set aside when Replace home swapped it
						out. Delete it once they confirm the restored home is right.
					</Toggletip>
				}
			>
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
									<Button
										size="sm"
										data-testid="backup-kept-home-delete"
										aria-label={
											deleting
												? `Deleting the kept home of ${name}`
												: `Delete the kept home of ${name}`
										}
										aria-disabled={deleting ? true : undefined}
										onClick={() => {
											if (!deleting)
												onDelete({ kind: "kept", volume: kept.volume, name });
										}}
									>
										{deleting ? "Deleting…" : "Delete…"}
									</Button>
								</td>
							</tr>
						);
					})}
				</Table>
			</Part>
		</>
	);
}

function DumpsPart({
	host,
	requests,
	onDelete,
}: {
	host: Host;
	requests: BackupRequestView[];
	onDelete: (target: DeleteTarget) => void;
}) {
	return (
		<Part
			id="backups-dumps-title"
			title="Pre-change database dumps"
			help={
				<Toggletip label="pre-change database dumps">
					Copies of the platform database that the operator saves on the backup host
					before each deploy or other change. Delete them once the change has settled.
				</Toggletip>
			}
		>
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
							<td className="tabular-nums">{formatBytes(dump.sizeBytes)}</td>
							<td>{longTime(dump.modifiedAt)}</td>
							<td className="pk-cell-actions">
								<Button
									size="sm"
									data-testid="backup-dump-delete"
									aria-label={
										deleting ? `Deleting ${dump.file}` : `Delete ${dump.file}`
									}
									aria-disabled={deleting ? true : undefined}
									onClick={() => {
										if (!deleting) onDelete({ kind: "dump", file: dump.file });
									}}
								>
									{deleting ? "Deleting…" : "Delete…"}
								</Button>
							</td>
						</tr>
					);
				})}
			</Table>
		</Part>
	);
}

function RecentGroup({
	requests,
	workspaces,
}: {
	requests: BackupRequestView[];
	workspaces: BackupWorkspace[];
}) {
	const shown = requests.slice(0, RECENT_SHOWN);
	return (
		<Group id="backups-recent-title" title="Recent requests">
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
		</Group>
	);
}
