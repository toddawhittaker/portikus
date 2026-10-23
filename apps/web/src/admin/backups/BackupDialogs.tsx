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
	useToast,
} from "@portikus/ui";
import { useState } from "react";
import { errorText } from "../../api/request.js";
import { ConfirmByLabelDialog } from "../ConfirmByLabelDialog.js";
import { setTime, workspaceName } from "./model.js";
import { type DeleteOutcome, useAdminBackups, useRestoreCopy } from "./queries.js";
import {
	type DeleteTarget,
	deleteCopy,
	kindsText,
	targetKey,
	targetName,
} from "./selection.js";

const STOPPED_WARNING =
	"Start this workspace first. The copy is written by the student's own account inside the running workspace.";

/** What the delete confirm asks about, and how the last try went. */
export interface PendingDelete {
	targets: DeleteTarget[];
	/** What the last try requested; the dialog stays open only when some failed. */
	done: DeleteTarget[];
	failed: DeleteOutcome["failed"];
	/** The ticked count when the dialog opened; the page announces it again once the dialog closes. */
	selectedAtOpen: number;
	/** Where focus goes when the dialog closes; unset returns it to the opener. */
	returnTo?: () => HTMLElement | null;
}

/**
 * Confirm one delete or several; the host or the worker carries each out a
 * little later. After a partial failure the dialog stays open on the items
 * that were not deleted, each with its reason.
 */
export function DeleteDialog({
	confirm,
	pending,
	onClose,
	onConfirm,
}: {
	confirm: PendingDelete | null;
	pending: boolean;
	onClose: () => void;
	onConfirm: (confirm: PendingDelete) => void;
}) {
	const copy = confirm ? deleteCopy(confirm.targets) : null;
	return (
		<ConfirmDialogRoot
			open={confirm !== null}
			onOpenChange={(open) => (open || pending ? undefined : onClose())}
		>
			{confirm && copy ? (
				<ConfirmDialog
					id="backup-delete-dialog"
					testId="backup-delete-dialog"
					title={copy.title}
					description={copy.description.map((line) => (
						<span key={line} className="block">
							{line}
						</span>
					))}
					confirmLabel="Delete"
					pending={pending}
					cancelDisabled={pending}
					cancelDisabledReason="Wait for the deletes to finish"
					returnFocusTo={confirm.returnTo}
					onConfirm={() => onConfirm(confirm)}
				>
					{/* Always mounted, so the failures are read out when they arrive. */}
					<div
						role="alert"
						className="pk-text-compact"
						data-testid="backup-delete-failed"
					>
						{confirm.failed.length > 0 ? (
							<DeleteFailures done={confirm.done} failed={confirm.failed} />
						) : null}
					</div>
				</ConfirmDialog>
			) : null}
		</ConfirmDialogRoot>
	);
}

function DeleteFailures({
	done,
	failed,
}: {
	done: DeleteTarget[];
	failed: DeleteOutcome["failed"];
}) {
	return (
		<div className="flex flex-col gap-1">
			<p className="m-0">
				{done.length > 0 ? `Delete requested for ${kindsText(done)}. ` : null}
				{failed.length === 1
					? "This was not deleted:"
					: `These ${failed.length} were not deleted:`}
			</p>
			<ul className="m-0 list-none p-0 text-status-error [overflow-wrap:anywhere]">
				{failed.map((failure) => (
					<li key={targetKey(failure.target)}>
						{targetName(failure.target)}: {failure.reason}
					</li>
				))}
			</ul>
		</div>
	);
}

/** Opened from a workspace's panel: the workspace is fixed and the admin picks a set. */
export interface RestorePreset {
	workspaceId: string;
	/** Every set the host lists; undefined while they load. */
	sets: HostBackupSet[] | undefined;
	/** Why no restore is possible at all, such as backups not being connected. */
	unavailable?: string | null;
}

/** Everything the restore dialog shows, worked out from its inputs and the admin's choice. */
function restoreModel(
	set: HostBackupSet | null,
	preset: RestorePreset | null | undefined,
	workspaces: BackupWorkspace[],
	choice: string | undefined,
) {
	const fromSet = set !== null;
	// From a set: the workspaces it covers. From a workspace: the verified sets
	// holding it, newest first, since the host refuses the others.
	const covered = set
		? workspaces.filter((w) => set.instances.includes(w.instance))
		: [];
	const missing = set ? set.instances.length - covered.length : 0;
	const presetWorkspace = preset
		? workspaces.find((w) => w.id === preset.workspaceId)
		: undefined;
	const holding =
		preset?.sets && presetWorkspace
			? preset.sets
					.filter(
						(s) =>
							s.verified !== false && s.instances.includes(presetWorkspace.instance),
					)
					.sort((a, b) => b.stamp.localeCompare(a.stamp))
			: [];
	const onlyUnverified =
		holding.length === 0 &&
		presetWorkspace !== undefined &&
		(preset?.sets ?? []).some((s) => s.instances.includes(presetWorkspace.instance));
	const loading = preset !== null && preset !== undefined && preset.sets === undefined;

	const picked = set ? covered.find((w) => w.id === choice) : presetWorkspace;
	const stamp = set ? set.stamp : (choice ?? holding[0]?.stamp);
	const pickedSet = set ? set : holding.find((s) => s.stamp === stamp);
	const ready = picked !== undefined && pickedSet !== undefined;
	const stopped = picked !== undefined && picked.state !== "running";
	const unavailable = fromSet ? null : (preset?.unavailable ?? null);
	const noChoices = fromSet
		? covered.length === 0
		: unavailable !== null || (!loading && holding.length === 0);
	const folder = pickedSet ? restoreDirFor(pickedSet.stamp) : null;
	return {
		fromSet,
		covered,
		missing,
		presetWorkspace,
		holding,
		onlyUnverified,
		loading,
		picked,
		stamp,
		pickedSet,
		ready,
		stopped,
		unavailable,
		noChoices,
		folder,
	};
}

type RestoreModel = ReturnType<typeof restoreModel>;

/** Which note explains why the Restore copy button cannot be used yet. */
function restoreBlockerId(m: RestoreModel): string | undefined {
	if (m.noChoices) return "backup-restore-none";
	if (!m.ready) return "backup-restore-choose";
	if (m.stopped) return "backup-restore-stopped";
	return undefined;
}

function noChoicesText(m: RestoreModel): string {
	if (m.fromSet) return "None of the workspaces in this set exist on the platform now.";
	if (m.onlyUnverified)
		return "Only unverified backup sets hold this workspace, and they cannot be restored.";
	return "No backup set holds this workspace yet.";
}

/**
 * Restore one workspace from one set into a side copy in that student's home
 * (SPEC.md §24.9; ADR 0040). Nothing is overwritten. Opened from a set, the
 * admin picks the workspace; opened with `preset`, the admin picks the set.
 */
export function RestoreDialog({
	set,
	preset,
	workspaces,
	pending,
	serverError,
	onClose,
	onRestore,
}: {
	set: HostBackupSet | null;
	preset?: RestorePreset | null;
	workspaces: BackupWorkspace[];
	pending: boolean;
	serverError: string | null;
	onClose: () => void;
	onRestore: (workspaceId: string, stamp: string) => void;
}) {
	const [choice, setChoice] = useState<string | undefined>(undefined);
	const open = set !== null || (preset !== null && preset !== undefined);
	const m = restoreModel(set, preset, workspaces, choice);

	function close() {
		setChoice(undefined);
		onClose();
	}

	return (
		<DialogRoot open={open} onOpenChange={(next) => (next ? undefined : close())}>
			{open ? (
				<Dialog
					testId="backup-restore-dialog"
					title={set ? "Restore a workspace" : "Restore from backup"}
					description={
						set
							? `From the backup of ${setTime(set.stamp)}. The files are copied into a new folder in the student's home, next to their current files. Nothing is overwritten.`
							: "The files are copied into a new folder in the student's home, next to their current files. Nothing is overwritten."
					}
					footer={
						<>
							<Button onClick={close}>Cancel</Button>
							<Button
								variant="primary"
								data-testid="backup-restore-confirm"
								loading={pending}
								aria-disabled={!m.ready || m.stopped ? true : undefined}
								aria-describedby={restoreBlockerId(m)}
								onClick={() => {
									if (m.picked && m.pickedSet && !m.stopped)
										onRestore(m.picked.id, m.pickedSet.stamp);
								}}
							>
								Restore copy
							</Button>
						</>
					}
				>
					{m.unavailable ? (
						<p
							id="backup-restore-none"
							className="m-0 text-[13px]"
							data-testid="backup-restore-none"
						>
							{m.unavailable}
						</p>
					) : (
						<RestoreBody
							m={m}
							workspaces={workspaces}
							choice={choice}
							setChoice={setChoice}
							serverError={serverError}
						/>
					)}
				</Dialog>
			) : null}
		</DialogRoot>
	);
}

function RestorePicker({
	m,
	workspaces,
	choice,
	setChoice,
}: {
	m: RestoreModel;
	workspaces: BackupWorkspace[];
	choice: string | undefined;
	setChoice: (value: string) => void;
}) {
	if (m.noChoices)
		return (
			<p
				id="backup-restore-none"
				className="m-0 text-[13px]"
				data-testid="backup-restore-none"
			>
				{noChoicesText(m)}
			</p>
		);
	if (m.fromSet)
		return (
			<Select
				id="backup-restore-workspace"
				label="Workspace"
				placeholder="Choose a workspace"
				value={choice ?? ""}
				onValueChange={setChoice}
				options={m.covered.map((w) => ({
					value: w.id,
					label: `${workspaceName(w.instance, workspaces)}${w.state === "running" ? "" : `, ${w.state}`}`,
				}))}
			/>
		);
	return (
		<Select
			id="backup-restore-set"
			label="Backup set"
			placeholder={m.loading ? "Loading backup sets…" : "Choose a backup set"}
			disabled={m.loading}
			value={m.stamp ?? ""}
			onValueChange={setChoice}
			options={m.holding.map((s) => ({
				value: s.stamp,
				label: `${setTime(s.stamp)}${s.complete ? "" : ", incomplete"}`,
			}))}
		/>
	);
}

function RestoreBody({
	m,
	workspaces,
	choice,
	setChoice,
	serverError,
}: {
	m: RestoreModel;
	workspaces: BackupWorkspace[];
	choice: string | undefined;
	setChoice: (value: string) => void;
	serverError: string | null;
}) {
	const { missing } = m;
	return (
		<div className="flex flex-col gap-3">
			<RestorePicker
				m={m}
				workspaces={workspaces}
				choice={choice}
				setChoice={setChoice}
			/>
			{!m.noChoices && !m.loading && !m.ready ? (
				<p id="backup-restore-choose" className="pk-muted m-0 text-[13px]">
					{m.fromSet ? "Choose a workspace to restore." : "Choose a backup set."}
				</p>
			) : null}
			{missing > 0 && m.covered.length > 0 ? (
				<p className="pk-muted m-0 text-[13px]">
					{missing} workspace{missing === 1 ? "" : "s"} in this set no longer exist
					{missing === 1 ? "s" : ""} and cannot be restored here.
				</p>
			) : null}
			<dl className="pk-dl text-[13px]">
				{m.presetWorkspace ? (
					<>
						<dt>Workspace</dt>
						<dd data-testid="backup-restore-workspace-name">
							{workspaceName(m.presetWorkspace.instance, workspaces)}
						</dd>
					</>
				) : null}
				<dt>Copied into</dt>
				<dd className="font-mono" data-testid="backup-restore-folder">
					{m.folder ? `~/${m.folder}` : "Not chosen yet"}
				</dd>
			</dl>
			<p className="pk-muted m-0 text-[13px]">
				The workspace must be running. If the folder already exists, or the home does
				not have room for the copy, the host refuses and nothing changes. The student is
				told when the copy is done.
			</p>
			{m.stopped ? (
				<p id="backup-restore-stopped" className="m-0 text-[13px] text-status-warning">
					{STOPPED_WARNING}
				</p>
			) : null}
			{/* Always mounted so the warning is announced when it appears. */}
			<span className="sr-only" role="status">
				{m.stopped ? STOPPED_WARNING : ""}
			</span>
			{serverError ? (
				<p className="m-0 text-[13px] text-status-error" role="alert">
					{serverError}
				</p>
			) : null}
		</div>
	);
}

/**
 * RestoreDialog for one workspace, loading the sets itself, for a caller
 * outside the Backups tab such as the workspace's panel. Renders nothing,
 * and fetches nothing, while `workspaceId` is null.
 */
export function RestoreFromBackupDialog({
	workspaceId,
	onClose,
}: {
	workspaceId: string | null;
	onClose: () => void;
}) {
	if (workspaceId === null) return null;
	return <RestoreFromBackupOpen workspaceId={workspaceId} onClose={onClose} />;
}

function RestoreFromBackupOpen({
	workspaceId,
	onClose,
}: {
	workspaceId: string;
	onClose: () => void;
}) {
	const backups = useAdminBackups();
	const restore = useRestoreCopy();
	const toast = useToast();
	const [error, setError] = useState<string | null>(null);
	const data = backups.data;
	const sets = data ? (data.host?.sets ?? []) : backups.isError ? [] : undefined;
	const unavailable = backups.isError
		? errorText(backups.error)
		: data && !data.host
			? "Backups are not connected on this site."
			: null;
	return (
		<RestoreDialog
			set={null}
			preset={{ workspaceId, sets, unavailable }}
			workspaces={data?.workspaces ?? []}
			pending={restore.isPending}
			serverError={error}
			onClose={onClose}
			onRestore={(id, stamp) => {
				setError(null);
				restore.mutate(
					{ stamp, workspaceId: id },
					{
						onSuccess: () => {
							toast.show({ tone: "success", title: "Restore requested" });
							onClose();
						},
						onError: (e) => setError(errorText(e)),
					},
				);
			}}
		/>
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
					The current home folder is kept, and listed under Clean up below until you
					delete it.
				</li>
				<li>The workspace starts again if it was running.</li>
			</ul>
		</ConfirmByLabelDialog>
	);
}
