import type {
	AdminCapabilities,
	AdminStorage,
	AdminUser,
	AdminWorkspaceDetail,
	QuotaConfig,
} from "@portikus/contracts";
import {
	Button,
	Checkbox,
	ConfirmDialog,
	ConfirmDialogRoot,
	IconButton,
	TextField,
	useToast,
} from "@portikus/ui";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { formatBytes, formatCpu } from "../monitor/format.js";
import { PENDING_LABEL } from "../shell/StatusBar.js";
import { ConfirmByLabelDialog } from "./ConfirmByLabelDialog.js";
import { defaultLabel, graceText } from "./graceText.js";
import { logCommand } from "./logCommand.js";
import { imageText } from "./markers.js";
import { QuotaDialog } from "./QuotaDialog.js";
import {
	useAdminWorkspace,
	useLifecycleAction,
	usePlatformSettings,
	useRebuild,
	useResetDocker,
	useSetArchived,
	useSetDisabled,
	useUpdateQuota,
	useUpdateUserSettings,
} from "./queries.js";
import { announced, errorText, parseSeconds } from "./SettingsTab.js";
import { storageText, WorkspaceStateBadge } from "./WorkspacesTab.js";

/** A storage class at or above this share of its limit is flagged (SPEC.md §19.2). */
export const STORAGE_WARN_RATIO = 0.8;

/** True while the worker has not yet applied the sizes an administrator asked for. */
export function quotaPending(
	config: QuotaConfig,
	applied: QuotaConfig | null | undefined,
): boolean {
	return (
		!applied ||
		applied.homeGiB !== config.homeGiB ||
		applied.dockerGiB !== config.dockerGiB
	);
}

/** Why a button for an operation this build does not have is off (Epic 11 brief, ruling 1). */
export const NOT_AVAILABLE_TEXT =
	"Rebuild and Reset Docker are not available in this release.";

type DialogName = "rebuild" | "reset" | "quota" | "disable" | "archive";

/** The panel beside the table for one account and its workspace (SPEC.md §20.1). */
export function WorkspaceDetail({
	user,
	isSelf,
	onClose,
}: {
	user: AdminUser;
	isSelf: boolean;
	onClose: () => void;
}) {
	const workspaceId = user.workspace?.id ?? null;
	const detail = useAdminWorkspace(workspaceId);
	const data = detail.data ?? null;
	const headingRef = useRef<HTMLHeadingElement>(null);
	const userId = user.id;

	// Opening a panel moves focus to its heading so the change is announced.
	useEffect(() => {
		if (userId) headingRef.current?.focus();
	}, [userId]);

	return (
		<section
			id="workspace-detail"
			className="pk-card flex w-[400px] flex-none flex-col gap-4 p-5"
			aria-labelledby="detail-title"
			data-testid="workspace-detail"
		>
			<div className="flex items-start gap-3">
				<div className="flex min-w-0 flex-col gap-0.5">
					<h2
						id="detail-title"
						ref={headingRef}
						tabIndex={-1}
						className="pk-text-heading m-0 outline-none"
					>
						{user.displayName}
					</h2>
					<span className="pk-mono-small pk-muted">
						{[user.workspace?.label, user.email].filter(Boolean).join(" · ")}
					</span>
				</div>
				<IconButton
					icon="x"
					size="sm"
					className="ml-auto"
					label={`Close details for ${user.displayName}`}
					onClick={onClose}
				/>
			</div>
			{workspaceId === null ? (
				<p className="pk-text-body pk-muted m-0">This account has no workspace.</p>
			) : data ? (
				<WorkspaceSections detail={data} ownerName={user.displayName} />
			) : detail.isError ? (
				<p className="m-0 text-status-error" role="alert">
					{errorText(detail.error)}
				</p>
			) : (
				<p className="pk-muted m-0" aria-busy="true">
					Loading…
				</p>
			)}
			<AccountSection user={user} isSelf={isSelf} />
		</section>
	);
}

function WorkspaceSections({
	detail,
	ownerName,
}: {
	detail: AdminWorkspaceDetail;
	ownerName: string;
}) {
	const workspace = detail.workspace;
	const toast = useToast();
	const command = logCommand(workspace.id, workspace.incusInstanceName);

	async function copyCommand() {
		try {
			await navigator.clipboard.writeText(command);
			toast.show({ tone: "success", title: "Log command copied" });
		} catch {
			toast.show({
				tone: "danger",
				title: "Could not copy. Select the command instead.",
			});
		}
	}

	return (
		<>
			<div className="flex items-center gap-2">
				{/* Announces each state change while the panel refreshes. */}
				<span role="status" data-testid="detail-state">
					<WorkspaceStateBadge
						state={workspace.state}
						desiredState={workspace.desiredState}
					/>
				</span>
				{workspace.archivedAt ? <span className="pk-tag">Archived</span> : null}
			</div>

			{workspace.errorCode || workspace.errorMessage ? (
				<section aria-label="Error" className="flex flex-col gap-2">
					<p className="pk-text-compact m-0">
						{workspace.errorMessage ?? "The workspace reported an error."}
					</p>
					<dl className="pk-techdetail">
						<div>
							<dt className="inline">errorCode: </dt>
							<dd className="inline">{workspace.errorCode ?? "—"}</dd>
						</div>
						<div>
							<dt className="inline">errorMessage: </dt>
							<dd className="inline">{workspace.errorMessage ?? "—"}</dd>
						</div>
					</dl>
				</section>
			) : null}

			<section aria-labelledby="detail-logs" className="flex flex-col gap-2">
				<h3 id="detail-logs" className="pk-text-label m-0">
					Logs
				</h3>
				<code className="pk-techdetail break-all" data-testid="log-command">
					{command}
				</code>
				<div>
					<Button size="sm" onClick={() => void copyCommand()}>
						Copy log command
					</Button>
				</div>
			</section>

			<StorageSection detail={detail} />

			<section aria-labelledby="detail-ports" className="flex flex-col gap-2">
				<h3 id="detail-ports" className="pk-text-label m-0">
					Preview ports
				</h3>
				{detail.ports.length === 0 ? (
					<p className="pk-muted m-0 text-[13px]">No listening ports.</p>
				) : (
					<table className="w-full text-left text-[13px]" data-testid="detail-ports">
						<caption className="sr-only">Listening ports</caption>
						<thead>
							<tr className="text-ink-muted">
								<th scope="col" className="font-medium">
									Port
								</th>
								<th scope="col" className="font-medium">
									Process
								</th>
								<th scope="col" className="font-medium">
									Preview
								</th>
							</tr>
						</thead>
						<tbody>
							{detail.ports.map((port) => (
								<tr key={port.port}>
									<td className="pk-mono-small">{port.port}</td>
									<td>
										{port.command ?? "—"}
										{port.system ? <span className="pk-tag ml-1">System</span> : null}
									</td>
									<td>{port.previewReachability}</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
				<p className="m-0 text-[13px]" data-testid="detail-sessions">
					{detail.previewSessions.length === 0
						? "No open preview sessions."
						: `Open preview sessions: ${detail.previewSessions
								.map(
									(session) =>
										`port ${session.port} since ${shortTime(session.openedAt)}`,
								)
								.join(", ")}.`}
				</p>
			</section>

			<section aria-labelledby="detail-audit" className="flex flex-col gap-2">
				<h3 id="detail-audit" className="pk-text-label m-0">
					Recent audit events
				</h3>
				<ul className="m-0 flex list-none flex-col gap-1 p-0 text-[13px]">
					{detail.recentAudit.map((event) => (
						<li key={event.id} className="flex gap-2">
							<time dateTime={event.at} className="pk-muted">
								{shortTime(event.at)}
							</time>
							<span>
								<span className="pk-mono-small">{event.action}</span> ·{" "}
								{event.actorName ?? event.actor}
							</span>
						</li>
					))}
				</ul>
				<Link
					to="/admin"
					search={{ tab: "audit", workspace: workspace.id }}
					className="pk-link text-[13px] text-[var(--accent-text)] underline"
					data-testid="detail-all-events"
				>
					All events for this workspace
				</Link>
			</section>

			<WorkspaceActions detail={detail} ownerName={ownerName} />
		</>
	);
}

function shortTime(iso: string): string {
	return new Date(iso).toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

function StorageSection({ detail }: { detail: AdminWorkspaceDetail }) {
	const { workspace } = detail;
	const pending = quotaPending(workspace.quotaConfig, detail.quotaApplied);
	return (
		<section aria-labelledby="detail-storage" className="flex flex-col gap-2">
			<h3 id="detail-storage" className="pk-text-label m-0">
				Storage and usage
			</h3>
			<p className="m-0 text-[13px]" data-testid="detail-quota">
				Configured: {storageText(workspace.quotaConfig)}
			</p>
			{pending ? (
				<p
					className="m-0 text-[13px] text-status-warning"
					data-testid="detail-quota-pending"
				>
					Change pending. The worker applies it shortly.
				</p>
			) : null}
			{detail.storage ? <StorageMeters storage={detail.storage} /> : null}
			<p className="m-0 text-[13px]" data-testid="detail-usage">
				{detail.agent === "stopped"
					? "Stopped"
					: detail.agent === "not_answering" || !detail.usage
						? "Agent not answering"
						: `Home disk ${formatBytes(detail.usage.disk.usedBytes)} of ${formatBytes(
								detail.usage.disk.totalBytes,
							)} · CPU ${formatCpu(detail.usage.cpuPercent)} · Memory ${formatBytes(
								detail.usage.memory.usedBytes,
							)} of ${formatBytes(detail.usage.memory.totalBytes)}`}
			</p>
			<p className="m-0 text-[13px]">
				Image <span className="pk-mono-small">{imageText(detail.image)}</span>
			</p>
		</section>
	);
}

const STORAGE_LABEL: Record<keyof AdminStorage, string> = {
	home: "Projects and home",
	docker: "Docker",
	recovery: "Recovery",
};

function StorageMeters({ storage }: { storage: AdminStorage }) {
	return (
		<div className="flex flex-col gap-2">
			{(Object.keys(STORAGE_LABEL) as (keyof AdminStorage)[]).map((key) => {
				const { usedBytes, limitBytes } = storage[key];
				const ratio = limitBytes > 0 ? usedBytes / limitBytes : 0;
				const warn = ratio >= STORAGE_WARN_RATIO;
				const text = `${formatBytes(usedBytes)} of ${formatBytes(limitBytes)}${
					warn ? ", nearly full" : ""
				}`;
				const id = `storage-${key}`;
				return (
					<div key={key} className="flex flex-col text-[13px]">
						<div className="flex justify-between">
							<label htmlFor={id}>{STORAGE_LABEL[key]}</label>
							<span className={warn ? "text-status-warning" : undefined}>{text}</span>
						</div>
						<meter
							id={id}
							className="w-full"
							min={0}
							max={Math.max(limitBytes, 1)}
							high={limitBytes * STORAGE_WARN_RATIO}
							value={usedBytes}
							aria-valuetext={text}
						/>
					</div>
				);
			})}
		</div>
	);
}

/** The explanation shown under a Rebuild or Reset Docker button that is off. */
export function capabilityNote(capabilities: AdminCapabilities): string | null {
	if (!capabilities.rebuild && !capabilities.resetDocker) return NOT_AVAILABLE_TEXT;
	if (!capabilities.rebuild) return "Rebuild is not available in this release.";
	if (!capabilities.resetDocker)
		return "Reset Docker is not available in this release.";
	return null;
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
	const lifecycle = useLifecycleAction();
	const rebuild = useRebuild();
	const resetDocker = useResetDocker();
	const archive = useSetArchived();
	const quota = useUpdateQuota();
	const [dialog, setDialog] = useState<DialogName | null>(null);
	const [preserveDocker, setPreserveDocker] = useState(true);
	const archived = workspace.archivedAt !== null;
	// A second request would only answer 409 OPERATION_PENDING (ADR 0021).
	const operationPending = workspace.pendingOperation !== null;
	const note = capabilityNote(capabilities);
	const noteId = `capability-note-${workspace.id}`;

	function fail(title: string) {
		return (error: unknown) =>
			toast.show({ tone: "danger", title, children: errorText(error) });
	}

	function runLifecycle(action: "start" | "stop" | "restart") {
		if (lifecycle.isPending) return;
		lifecycle.mutate(
			{ workspaceId: workspace.id, action },
			{
				onSuccess: () =>
					toast.show({
						tone: "success",
						title: `${ACTION_DONE[action]} ${ownerName}'s workspace`,
					}),
				onError: fail(`Could not ${action} the workspace`),
			},
		);
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
		<section aria-labelledby="detail-actions" className="flex flex-col gap-2">
			<h3 id="detail-actions" className="pk-text-label m-0">
				Workspace actions
			</h3>
			<div className="flex flex-wrap gap-2">
				{(["start", "stop", "restart"] as const).map((action) => (
					<Button
						key={action}
						size="sm"
						data-testid={`detail-${action}`}
						aria-label={`${ACTION_LABEL[action]} ${ownerName}'s workspace`}
						loading={lifecycle.isPending && lifecycle.variables?.action === action}
						aria-disabled={lifecycle.isPending ? true : undefined}
						onClick={() => runLifecycle(action)}
					>
						{ACTION_LABEL[action]}
					</Button>
				))}
				<Button
					size="sm"
					data-testid="detail-quota-edit"
					aria-label={`Change storage for ${ownerName}'s workspace`}
					onClick={() => setDialog("quota")}
				>
					Change storage…
				</Button>
				<Button
					size="sm"
					data-testid="detail-archive"
					aria-label={`${archived ? "Unarchive" : "Archive"} workspace for ${ownerName}`}
					loading={archived && archive.isPending}
					onClick={() => (archived ? unarchive() : setDialog("archive"))}
				>
					{archived ? "Unarchive" : "Archive workspace…"}
				</Button>
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
			</div>
			{workspace.pendingOperation ? (
				<p
					id={pendingId}
					className="pk-muted m-0 text-[13px]"
					data-testid="pending-operation"
				>
					{PENDING_LABEL[workspace.pendingOperation]} Rebuild and Reset Docker are off
					until it finishes.
				</p>
			) : null}
			{note ? (
				<p
					id={noteId}
					className="pk-muted m-0 text-[13px]"
					data-testid="capability-note"
				>
					{note}
				</p>
			) : null}

			{dialog === "quota" ? (
				<QuotaDialog
					open
					onOpenChange={(open) => {
						if (!open) {
							quota.reset();
							close();
						}
					}}
					current={workspace.quotaConfig}
					ownerName={ownerName}
					pending={quota.isPending}
					serverError={quota.error ? errorText(quota.error) : null}
					onSave={(next) =>
						quota.mutate(
							{ workspaceId: workspace.id, quota: next },
							{
								onSuccess: () => {
									toast.show({ tone: "success", title: "Storage change requested" });
									close();
								},
							},
						)
					}
				/>
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
				description={
					<>
						The workspace is recreated from the current image. Projects and home stay.{" "}
						<Checkbox
							label="Keep Docker images and volumes"
							checked={preserveDocker}
							onChange={(event) => setPreserveDocker(event.target.checked)}
						/>
					</>
				}
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
			/>

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
		</section>
	);
}

const ACTION_LABEL = { start: "Start", stop: "Stop", restart: "Restart" } as const;
const ACTION_DONE = {
	start: "Asked to start",
	stop: "Asked to stop",
	restart: "Asked to restart",
} as const;

/** Disable or enable the account, and its grace override (SPEC.md §6.4, §20.1). */
function AccountSection({ user, isSelf }: { user: AdminUser; isSelf: boolean }) {
	const toast = useToast();
	const setDisabled = useSetDisabled();
	const [confirming, setConfirming] = useState(false);
	const disabled = user.disabledAt !== null;
	const selfNoteId = `self-note-${user.id}`;

	function run(next: boolean) {
		if (setDisabled.isPending) return;
		setDisabled.mutate(
			{ userId: user.id, disabled: next },
			{
				onSuccess: () => {
					toast.show({
						tone: "success",
						title: next
							? `${user.displayName} disabled`
							: `${user.displayName} enabled`,
					});
					setConfirming(false);
				},
				onError: (error) =>
					toast.show({
						tone: "danger",
						title: next
							? "Could not disable the account"
							: "Could not enable the account",
						children: errorText(error),
					}),
			},
		);
	}

	return (
		<section aria-labelledby="detail-account" className="flex flex-col gap-2">
			<h3 id="detail-account" className="pk-text-label m-0">
				Account
			</h3>
			<div>
				<Button
					size="sm"
					data-testid="detail-disable"
					aria-label={`${disabled ? "Enable" : "Disable"} account for ${user.displayName}`}
					aria-describedby={isSelf ? selfNoteId : undefined}
					aria-disabled={isSelf ? true : undefined}
					loading={disabled && setDisabled.isPending}
					onClick={() => {
						if (isSelf) return;
						if (disabled) run(false);
						else setConfirming(true);
					}}
				>
					{disabled ? "Enable account" : "Disable account…"}
				</Button>
			</div>
			{isSelf ? (
				<p id={selfNoteId} className="pk-muted m-0 text-[13px]">
					You cannot disable your own account.
				</p>
			) : null}
			<ConfirmDialogRoot open={confirming} onOpenChange={setConfirming}>
				<ConfirmDialog
					id="disable-dialog"
					testId="disable-dialog"
					title={`Disable ${user.displayName}?`}
					description="They are signed out everywhere, their previews close, and their workspace stops. Nothing is deleted."
					confirmLabel="Disable"
					pending={setDisabled.isPending}
					onConfirm={() => run(true)}
				/>
			</ConfirmDialogRoot>
			<UserGrace user={user} />
		</section>
	);
}

/** The per-user grace override, moved here from the old users table. */
function UserGrace({ user }: { user: AdminUser }) {
	const settings = usePlatformSettings();
	const globalSeconds = settings.data?.shutdownGraceSeconds ?? null;
	const update = useUpdateUserSettings();
	const toast = useToast();
	const [draft, setDraft] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const value =
		draft ??
		(user.shutdownGraceSeconds === null ? "" : String(user.shutdownGraceSeconds));
	const blank = value.trim() === "";
	const seconds = blank ? null : parseSeconds(value);
	const effective = blank ? globalSeconds : seconds;

	function save() {
		if (!blank && seconds === null) {
			setError("Enter a whole number of seconds, 0 or more.");
			return;
		}
		setError(null);
		update.mutate(
			{ userId: user.id, body: { shutdownGraceSeconds: blank ? null : seconds } },
			{
				onSuccess: () => {
					setDraft(null);
					toast.show({ tone: "success", title: `Saved ${user.displayName}` });
				},
				onError: (failure) => setError(errorText(failure)),
			},
		);
	}

	return (
		<div className="pk-actions items-end">
			<TextField
				id={`user-grace-${user.id}`}
				label="Grace period override (seconds)"
				className="w-48"
				inputMode="numeric"
				placeholder={globalSeconds === null ? undefined : defaultLabel(globalSeconds)}
				data-testid={`user-grace-input-${user.id}`}
				value={value}
				hint={effective === null ? undefined : graceText(effective)}
				error={announced(error)}
				onChange={(event) => setDraft(event.target.value)}
			/>
			<Button
				data-testid={`user-grace-save-${user.id}`}
				loading={update.isPending}
				aria-label={`Save ${user.displayName}`}
				onClick={save}
			>
				Save
			</Button>
		</div>
	);
}
