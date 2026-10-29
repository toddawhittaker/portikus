import type {
	AdminBackups,
	BackupRequestView,
	HostBackupSet,
} from "@portikus/contracts";
import { Button, Toggletip } from "@portikus/ui";
import { Fragment, type ReactNode } from "react";
import { formatBytes } from "../../monitor/format.js";
import { sampleAge } from "../health/HealthTab.js";
import { longTime, runningText, setTime } from "./model.js";
import { FocusCatchGroup, SELECT_CELL, Table } from "./parts.js";
import {
	DeleteSelectedButton,
	type ListSelection,
	SelectAllBox,
	SelectBox,
} from "./SelectBoxes.js";
import {
	type DeleteTarget,
	deleteWaiting,
	floorReasons,
	targetKey,
} from "./selection.js";

export type Host = NonNullable<AdminBackups["host"]>;

export function StatusPart({
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
		<FocusCatchGroup
			level={4}
			id="backups-status-title"
			title="Status"
			testId="backups-status"
		>
			{/*
			 * Pairs sit side by side once the card is wide enough, with more room
			 * between pairs than between a label and its value.
			 */}
			<dl className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-6 gap-y-2 text-[13px] @3xl:grid-cols-[max-content_minmax(0,1fr)_max-content_minmax(0,1fr)] @3xl:[&>dt:nth-of-type(2n)]:ps-4">
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
		</FocusCatchGroup>
	);
}

export function SetsPart({
	host,
	requests,
	onRestore,
	onDelete,
	selection,
}: {
	host: Host;
	requests: BackupRequestView[];
	onRestore: (set: HostBackupSet) => void;
	onDelete: (target: DeleteTarget) => void;
	selection: ListSelection;
}) {
	const kept = floorReasons(host);
	return (
		<FocusCatchGroup
			level={4}
			id="backups-sets-title"
			title="Backup sets"
			actions={
				<DeleteSelectedButton
					kind="set"
					listId="backups-sets-title"
					selection={selection}
				/>
			}
		>
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
				selectAll={<SelectAllBox kind="set" noun="backup sets" selection={selection} />}
			>
				{host.sets.map((set) => (
					<SetRow
						key={set.stamp}
						set={set}
						keyInstalled={host.keyInstalled}
						keptReason={kept.get(set.stamp) ?? null}
						deleting={deleteWaiting(requests, { kind: "set", stamp: set.stamp })}
						onRestore={onRestore}
						onDelete={onDelete}
						selection={selection}
					/>
				))}
			</Table>
		</FocusCatchGroup>
	);
}

/** The notes after a set's result, joined with ". " so each gets one stop when read aloud. */
function setNotes(
	set: HostBackupSet,
	keyInstalled: boolean,
	keptReason: string | null,
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
	if (keptReason) {
		notes.push({
			key: "kept",
			node: (
				<span id={`backup-set-note-${set.stamp}`} className="pk-muted">
					{keptReason}
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
	keptReason,
	deleting,
	onRestore,
	onDelete,
	selection,
}: {
	set: HostBackupSet;
	keyInstalled: boolean;
	keptReason: string | null;
	deleting: boolean;
	onRestore: (set: HostBackupSet) => void;
	onDelete: (target: DeleteTarget) => void;
	selection: ListSelection;
}) {
	const when = setTime(set.stamp);
	const noteId = `backup-set-note-${set.stamp}`;
	const restoreOff =
		!keyInstalled || set.verified === false || set.instances.length === 0;
	return (
		<tr data-testid={`backup-set-${set.stamp}`}>
			<td className={SELECT_CELL}>
				<SelectBox
					itemKey={targetKey({ kind: "set", stamp: set.stamp })}
					label={`Select the set from ${when}`}
					selection={selection}
				/>
			</td>
			<th scope="row">{when}</th>
			<td>
				<SetResult set={set} notes={setNotes(set, keyInstalled, keptReason)} />
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
						aria-disabled={keptReason || deleting ? true : undefined}
						aria-describedby={keptReason ? noteId : undefined}
						onClick={() => {
							if (!keptReason && !deleting) onDelete({ kind: "set", stamp: set.stamp });
						}}
					>
						{deleting ? "Deleting…" : "Delete…"}
					</Button>
				</div>
			</td>
		</tr>
	);
}
