import type {
	AdminCapabilities,
	AdminStorage,
	AdminUser,
	AdminWorkspaceDetail,
	CpuThrottle,
	EffectiveGuard,
	GuardConfig,
	MemoryFlag,
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
import { DexUserActions } from "./DexUserDialogs.js";
import { GuardDialog } from "./GuardDialog.js";
import { defaultLabel, graceText } from "./graceText.js";
import { imageText, isCourseAccount, roleText, sourceText } from "./markers.js";
import { QuotaDialog } from "./QuotaDialog.js";
import {
	useAdminWorkspace,
	useGuardClear,
	useLifecycleAction,
	usePlatformSettings,
	useRebuild,
	useResetDocker,
	useSetArchived,
	useSetDisabled,
	useSetGrantedAdmin,
	useSetGrantedInstructor,
	useUpdateGuard,
	useUpdateQuota,
	useUpdateUserSettings,
} from "./queries.js";
import { announced, errorText, parseSeconds } from "./SettingsTab.js";
import { shortTime } from "./shortTime.js";
import { storageText, timeAgo, WorkspaceStateBadge } from "./WorkspacesTab.js";

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

type DialogName = "rebuild" | "reset" | "archive";

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
			// Sticks against the scrolling <main>: the window less the 48 px .pk-appbar and main's 32 px bottom padding.
			className="pk-card sticky top-0 flex max-h-[calc(100vh-80px)] w-[400px] flex-none flex-col self-start overflow-auto"
			aria-labelledby="detail-title"
			data-testid="workspace-detail"
		>
			<div className="pk-detail-head">
				<div className="flex min-w-0 flex-col gap-2">
					<div className="flex flex-col gap-0.5">
						<h3
							id="detail-title"
							ref={headingRef}
							tabIndex={-1}
							className="pk-text-heading m-0 outline-none"
						>
							{user.displayName}
						</h3>
						{user.workspace ? (
							<span className="pk-mono-small pk-muted">{user.workspace.label}</span>
						) : null}
					</div>
					{data ? <HeadState detail={data} ownerName={user.displayName} /> : null}
				</div>
				<IconButton
					icon="x"
					size="sm"
					label={`Close details for ${user.displayName}`}
					onClick={onClose}
				/>
			</div>
			{workspaceId !== null && !data ? (
				<div className="pk-detail-section">
					{detail.isError ? (
						<p className="m-0 text-status-error" role="alert">
							{errorText(detail.error)}
						</p>
					) : (
						<p className="pk-muted m-0" aria-busy="true">
							Loading…
						</p>
					)}
				</div>
			) : null}
			{data ? <ErrorSection detail={data} /> : null}
			<AccountSection user={user} isSelf={isSelf} />
			<WorkspaceSection detail={data} user={user} hasWorkspace={workspaceId !== null} />
			{data ? <DataSections detail={data} ownerName={user.displayName} /> : null}
		</section>
	);
}

/** The state badge and Start, Stop and Restart, directly under the name (SPEC.md section 20.1). */
function HeadState({
	detail,
	ownerName,
}: {
	detail: AdminWorkspaceDetail;
	ownerName: string;
}) {
	const { workspace } = detail;
	const toast = useToast();
	const lifecycle = useLifecycleAction();

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
				onError: (error) =>
					toast.show({
						tone: "danger",
						title: `Could not ${action} the workspace`,
						children: errorText(error),
					}),
			},
		);
	}

	return (
		<>
			<div className="flex items-center gap-2">
				{/* Announces each state change while the panel refreshes. */}
				<span role="status" data-testid="detail-state">
					<WorkspaceStateBadge
						state={workspace.state}
						desiredState={workspace.desiredState}
						statusRole={false}
					/>
				</span>
				{workspace.archivedAt ? <span className="pk-tag">Archived</span> : null}
			</div>
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
			</div>
		</>
	);
}

function ErrorSection({ detail }: { detail: AdminWorkspaceDetail }) {
	const { workspace } = detail;
	if (!workspace.errorCode && !workspace.errorMessage) return null;
	return (
		<section aria-labelledby="detail-error" className="pk-detail-section">
			<h4 id="detail-error" className="pk-text-label m-0">
				Error
			</h4>
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
	);
}

/** Storage, Resource guard, Ports and connections, Logs and Recent audit, in that order. */
function DataSections({
	detail,
	ownerName,
}: {
	detail: AdminWorkspaceDetail;
	ownerName: string;
}) {
	const workspace = detail.workspace;
	return (
		<>
			<StorageSection detail={detail} ownerName={ownerName} />

			<GuardSection detail={detail} ownerName={ownerName} />

			<section aria-labelledby="detail-ports" className="pk-detail-section">
				<h4 id="detail-ports" className="pk-text-label m-0">
					Ports and connections
				</h4>
				{detail.ports.length === 0 ? (
					<p className="pk-muted m-0 text-[13px]">No listening ports.</p>
				) : (
					<div className="pk-table-wrap">
						<table className="pk-table" data-testid="detail-ports">
							<caption className="sr-only">Listening ports</caption>
							<thead>
								<tr>
									<th scope="col" className="pk-num">
										Port
									</th>
									<th scope="col">Process</th>
									<th scope="col">Preview</th>
								</tr>
							</thead>
							<tbody>
								{detail.ports.map((port) => (
									<tr key={port.port}>
										<td className="pk-num pk-mono-small">{port.port}</td>
										<td>
											{port.command ?? "—"}
											{port.system ? <span className="pk-tag ml-1">System</span> : null}
										</td>
										<td>{port.previewReachability}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
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

			<section aria-labelledby="detail-logs" className="pk-detail-section">
				<h4 id="detail-logs" className="pk-text-label m-0">
					Logs
				</h4>
				<Link
					to="/admin"
					search={{ tab: "logs", workspace: workspace.id, since: "1h" }}
					className="pk-link text-[13px] text-[var(--accent-text)] underline"
					data-testid="detail-view-logs"
				>
					View logs
				</Link>
			</section>

			<section aria-labelledby="detail-audit" className="pk-detail-section">
				<h4 id="detail-audit" className="pk-text-label m-0">
					Recent audit events
				</h4>
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
		</>
	);
}

function StorageSection({
	detail,
	ownerName,
}: {
	detail: AdminWorkspaceDetail;
	ownerName: string;
}) {
	const { workspace } = detail;
	const toast = useToast();
	const quota = useUpdateQuota();
	const [editing, setEditing] = useState(false);
	const pending = quotaPending(workspace.quotaConfig, detail.quotaApplied);
	return (
		<section aria-labelledby="detail-storage" className="pk-detail-section">
			<div className="flex items-center justify-between gap-3">
				<h4 id="detail-storage" className="pk-text-label m-0">
					Storage
				</h4>
				<Button
					size="sm"
					data-testid="detail-quota-edit"
					aria-label={`Edit quotas for ${ownerName}'s workspace`}
					onClick={() => setEditing(true)}
				>
					Edit quotas…
				</Button>
			</div>
			<dl className="pk-dl">
				<dt>Configured</dt>
				<dd data-testid="detail-quota">{storageText(workspace.quotaConfig)}</dd>
				<dt>Usage</dt>
				<dd data-testid="detail-usage">
					{detail.agent === "stopped"
						? "Stopped"
						: detail.agent === "not_answering" || !detail.usage
							? "Agent not answering"
							: `Home disk ${formatBytes(detail.usage.disk.usedBytes)} of ${formatBytes(
									detail.usage.disk.totalBytes,
								)} · CPU ${formatCpu(detail.usage.cpuPercent)} · Memory ${formatBytes(
									detail.usage.memory.usedBytes,
								)} of ${formatBytes(detail.usage.memory.totalBytes)}`}
				</dd>
			</dl>
			{pending ? (
				<p
					className="m-0 text-[13px] text-status-warning"
					data-testid="detail-quota-pending"
				>
					Change pending. The worker applies it shortly.
				</p>
			) : null}
			{detail.storage ? <StorageMeters storage={detail.storage} /> : null}
			{editing ? (
				<QuotaDialog
					open
					onOpenChange={(open) => {
						if (!open) {
							quota.reset();
							setEditing(false);
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
									setEditing(false);
								},
							},
						)
					}
				/>
			) : null}
		</section>
	);
}

/** "Throttled since Sep 25, 14:02: …", or "Normal" (ADR 0032). */
export function throttleText(throttle: CpuThrottle | null): string {
	if (!throttle) return "Normal";
	return `Throttled since ${shortTime(throttle.at)}. It averaged ${Math.round(
		throttle.averagePercent,
	)}% over ${throttle.windowMinutes} minutes, above ${throttle.thresholdPercent}%, and now gets ${throttle.sharePercent}% of its CPU (${throttle.allowance}).`;
}

export function memoryFlagText(flag: MemoryFlag | null): string {
	if (!flag) return "Normal";
	return `High since ${shortTime(flag.at)}. It averaged ${Math.round(
		flag.averagePercent,
	)}% over ${flag.windowMinutes} minutes, above ${flag.thresholdPercent}%.`;
}

/** The limits this workspace runs with, marking the ones it overrides. */
export function effectiveGuardText(
	guard: EffectiveGuard,
	config: GuardConfig | null,
): string[] {
	const mark = (key: keyof EffectiveGuard) =>
		config?.[key] === undefined ? "" : " (override)";
	return [
		`CPU above ${guard.cpuThresholdPercent}%${mark("cpuThresholdPercent")} for ${guard.windowMinutes} minutes${mark("windowMinutes")} is slowed to ${guard.throttleSharePercent}%${mark("throttleSharePercent")}.`,
		`Memory above ${guard.memoryThresholdPercent}%${mark("memoryThresholdPercent")} is flagged.`,
		guard.idleStopMinutes === 0
			? `Never stopped for inactivity${mark("idleStopMinutes")}.`
			: `Stopped after ${guard.idleStopMinutes} minutes without activity${mark("idleStopMinutes")}.`,
	];
}

/** Throttle and memory flag, overrides and last activity (ADR 0032, SPEC.md §20.1). */
function GuardSection({
	detail,
	ownerName,
}: {
	detail: AdminWorkspaceDetail;
	ownerName: string;
}) {
	const { workspace, cpuThrottle, memoryFlag } = detail;
	const toast = useToast();
	const clear = useGuardClear();
	const update = useUpdateGuard();
	const settings = usePlatformSettings();
	const [editing, setEditing] = useState(false);
	const headingRef = useRef<HTMLHeadingElement>(null);
	const platform = settings.data
		? {
				cpuThresholdPercent: settings.data.cpuGuardThresholdPercent,
				memoryThresholdPercent: settings.data.memoryGuardThresholdPercent,
				windowMinutes: settings.data.guardWindowMinutes,
				throttleSharePercent: settings.data.cpuThrottleSharePercent,
				idleStopMinutes: settings.data.idleStopMinutes,
			}
		: null;

	function run(action: "lift-throttle" | "clear-memory-flag") {
		if (clear.isPending) return;
		clear.mutate(
			{ workspaceId: workspace.id, action },
			{
				onSuccess: () => {
					toast.show({
						tone: "success",
						title:
							action === "lift-throttle" ? "Throttle lifted" : "Memory flag cleared",
					});
					// The button goes with the state, so focus moves to the heading.
					headingRef.current?.focus();
				},
				onError: (error) =>
					toast.show({
						tone: "danger",
						title:
							action === "lift-throttle"
								? "Could not lift the throttle"
								: "Could not clear the memory flag",
						children: errorText(error),
					}),
			},
		);
	}

	return (
		<section aria-labelledby="detail-guard" className="pk-detail-section">
			<h4
				id="detail-guard"
				ref={headingRef}
				tabIndex={-1}
				className="pk-text-label m-0 outline-none"
			>
				Resource guard
			</h4>
			<dl className="pk-dl">
				<dt>CPU</dt>
				<dd
					className={cpuThrottle ? "text-status-warning" : undefined}
					data-testid="detail-guard-cpu"
				>
					{throttleText(cpuThrottle)}
				</dd>
				<dt>Memory</dt>
				<dd
					className={memoryFlag ? "text-status-warning" : undefined}
					data-testid="detail-guard-memory"
				>
					{memoryFlagText(memoryFlag)}
				</dd>
				<dt>Last activity</dt>
				<dd data-testid="detail-last-activity">
					{workspace.lastActivityAt
						? shortTime(workspace.lastActivityAt)
						: "None recorded"}
				</dd>
			</dl>
			<ul
				className="m-0 flex list-none flex-col gap-0.5 p-0 text-[13px]"
				data-testid="detail-guard-limits"
			>
				{effectiveGuardText(detail.effectiveGuard, detail.guardConfig).map((line) => (
					<li key={line}>{line}</li>
				))}
			</ul>
			<div className="flex flex-wrap gap-2">
				{cpuThrottle ? (
					<Button
						size="sm"
						data-testid="detail-lift-throttle"
						aria-label={`Lift throttle on ${ownerName}'s workspace`}
						loading={clear.isPending && clear.variables?.action === "lift-throttle"}
						onClick={() => run("lift-throttle")}
					>
						Lift throttle
					</Button>
				) : null}
				{memoryFlag ? (
					<Button
						size="sm"
						data-testid="detail-clear-memory-flag"
						aria-label={`Clear memory flag on ${ownerName}'s workspace`}
						loading={clear.isPending && clear.variables?.action === "clear-memory-flag"}
						onClick={() => run("clear-memory-flag")}
					>
						Clear memory flag
					</Button>
				) : null}
				<Button
					size="sm"
					data-testid="detail-guard-edit"
					aria-label={`Change overrides for ${ownerName}'s workspace`}
					onClick={() => setEditing(true)}
				>
					Change overrides…
				</Button>
			</div>
			{editing ? (
				<GuardDialog
					open
					onOpenChange={(open) => {
						if (!open) {
							update.reset();
							setEditing(false);
						}
					}}
					current={detail.guardConfig}
					defaults={platform}
					ownerName={ownerName}
					pending={update.isPending}
					serverError={update.error ? errorText(update.error) : null}
					onSave={(body) =>
						update.mutate(
							{ workspaceId: workspace.id, body },
							{
								onSuccess: () => {
									toast.show({ tone: "success", title: "Overrides saved" });
									setEditing(false);
								},
							},
						)
					}
				/>
			) : null}
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
		<div className="pk-meters">
			{(Object.keys(STORAGE_LABEL) as (keyof AdminStorage)[]).map((key) => {
				const { usedBytes, limitBytes } = storage[key];
				const ratio = limitBytes > 0 ? usedBytes / limitBytes : 0;
				const warn = ratio >= STORAGE_WARN_RATIO;
				const text = `${formatBytes(usedBytes)} of ${formatBytes(limitBytes)}${
					warn ? ", nearly full" : ""
				}`;
				const id = `storage-${key}`;
				return (
					<div key={key} className={warn ? "pk-meter pk-meter--warning" : "pk-meter"}>
						<div className="pk-meter-head">
							<label htmlFor={id} className="pk-meter-label">
								{STORAGE_LABEL[key]}
							</label>
							<span className="pk-meter-value">{text}</span>
						</div>
						{/* The native meter carries the value for screen readers; the track is drawn. */}
						<meter
							id={id}
							className="sr-only"
							min={0}
							max={Math.max(limitBytes, 1)}
							high={limitBytes * STORAGE_WARN_RATIO}
							value={usedBytes}
							aria-valuetext={text}
						/>
						<div className="pk-meter-track" aria-hidden="true">
							<div
								className="pk-meter-fill"
								style={{ width: `${Math.min(100, Math.round(ratio * 100))}%` }}
							/>
						</div>
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

/** Image, Rebuild, Reset Docker, Archive and the grace override (SPEC.md section 20.1). */
function WorkspaceSection({
	detail,
	user,
	hasWorkspace,
}: {
	detail: AdminWorkspaceDetail | null;
	user: AdminUser;
	hasWorkspace: boolean;
}) {
	return (
		<section aria-labelledby="detail-workspace" className="pk-detail-section">
			<h4 id="detail-workspace" className="pk-text-label m-0">
				Workspace
			</h4>
			{detail ? (
				<WorkspaceActions detail={detail} ownerName={user.displayName} />
			) : hasWorkspace ? null : (
				<p className="pk-text-body pk-muted m-0">This account has no workspace.</p>
			)}
			<UserGrace user={user} />
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
	const archived = workspace.archivedAt !== null;
	// A second request would only answer 409 OPERATION_PENDING (ADR 0021).
	const operationPending = workspace.pendingOperation !== null;
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
				<dd className="pk-mono-small">{imageText(detail.image)}</dd>
			</dl>
			<div className="flex flex-wrap gap-2">
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

const ACTION_LABEL = { start: "Start", stop: "Stop", restart: "Restart" } as const;
const ACTION_DONE = {
	start: "Asked to start",
	stop: "Asked to stop",
	restart: "Asked to restart",
} as const;

/** Why Promote or Demote is off for this account, or null when it is on (docs/archive/epics/EPIC-13-1.md ruling 23). */
export function roleChangeNote(user: AdminUser, isSelf: boolean): string | null {
	if (user.role !== "administrator") {
		return isCourseAccount(user.issuer)
			? "Only SSO accounts can be administrators."
			: null;
	}
	if (isSelf) return "You cannot demote your own account.";
	if (user.grantedRole !== "administrator") {
		return "This administrator comes from the SSO provider's groups.";
	}
	return null;
}

/** Promote to administrator, or demote a granted one (docs/archive/epics/EPIC-13-1.md ruling 23). */
function RoleChange({ user, isSelf }: { user: AdminUser; isSelf: boolean }) {
	const toast = useToast();
	const change = useSetGrantedAdmin();
	const [confirming, setConfirming] = useState(false);
	const promote = user.role !== "administrator";
	const note = roleChangeNote(user, isSelf);
	const noteId = `role-note-${user.id}`;
	const name = user.displayName;

	function open(next: boolean) {
		change.reset();
		setConfirming(next);
	}

	function run() {
		if (change.isPending) return;
		change.mutate(
			{ userId: user.id, admin: promote },
			{
				onSuccess: () => {
					toast.show({
						tone: "success",
						title: promote
							? `${name} is now an administrator`
							: `${name} is no longer an administrator`,
					});
					setConfirming(false);
				},
			},
		);
	}

	return (
		<>
			<Button
				size="sm"
				data-testid={promote ? "detail-promote" : "detail-demote"}
				aria-label={promote ? `Promote ${name} to administrator` : `Demote ${name}`}
				aria-describedby={note ? noteId : undefined}
				aria-disabled={note ? true : undefined}
				onClick={() => (note ? undefined : open(true))}
			>
				{promote ? "Promote…" : "Demote…"}
			</Button>
			{note ? (
				<p id={noteId} className="pk-muted m-0 w-full text-[13px]">
					{note}
				</p>
			) : null}
			<ConfirmDialogRoot open={confirming} onOpenChange={open}>
				<ConfirmDialog
					id={promote ? "promote-dialog" : "demote-dialog"}
					testId={promote ? "promote-dialog" : "demote-dialog"}
					title={promote ? `Make ${name} an administrator?` : `Demote ${name}?`}
					description={
						<>
							<span className="block">
								{promote
									? "They can see every account and workspace and change platform settings, from their next page load."
									: `They go back to ${roleText({ role: user.providerRole, grantedRole: null })}, from their next page load.`}
							</span>
							{change.error ? (
								<span
									className="mt-2 block text-status-error"
									role="alert"
									data-testid="role-change-error"
								>
									{errorText(change.error)}
								</span>
							) : null}
						</>
					}
					confirmLabel={promote ? "Promote" : "Demote"}
					pending={change.isPending}
					onConfirm={run}
				/>
			</ConfirmDialogRoot>
		</>
	);
}

/** Why Make instructor is off for this account, or null when it is on (docs/archive/epics/EPIC-14.md ruling 14). */
export function instructorChangeNote(user: AdminUser): string | null {
	if (user.grantedRole === "instructor") return null;
	if (isCourseAccount(user.issuer)) return "Only SSO accounts can be instructors.";
	if (user.grantedRole === "administrator") {
		return "This account is a granted administrator. Demote first.";
	}
	if (user.role !== "student") {
		return `Already ${user.role === "administrator" ? "an administrator" : "an instructor"} from the SSO provider.`;
	}
	return null;
}

/** Make instructor, or remove a granted instructor role (docs/archive/epics/EPIC-14.md ruling 14). */
function InstructorChange({ user }: { user: AdminUser }) {
	const toast = useToast();
	const change = useSetGrantedInstructor();
	const [confirming, setConfirming] = useState(false);
	const make = user.grantedRole !== "instructor";
	const note = instructorChangeNote(user);
	const noteId = `instructor-note-${user.id}`;
	const name = user.displayName;

	function open(next: boolean) {
		change.reset();
		setConfirming(next);
	}

	function run() {
		if (change.isPending) return;
		change.mutate(
			{ userId: user.id, instructor: make },
			{
				onSuccess: () => {
					toast.show({
						tone: "success",
						title: make
							? `${name} is now an instructor`
							: `${name} is no longer an instructor`,
					});
					setConfirming(false);
				},
			},
		);
	}

	return (
		<>
			<Button
				size="sm"
				data-testid={make ? "detail-make-instructor" : "detail-remove-instructor"}
				aria-label={make ? `Make instructor: ${name}` : `Remove instructor: ${name}`}
				aria-describedby={note ? noteId : undefined}
				aria-disabled={note ? true : undefined}
				onClick={() => (note ? undefined : open(true))}
			>
				{make ? "Make instructor…" : "Remove instructor…"}
			</Button>
			{note ? (
				<p id={noteId} className="pk-muted m-0 w-full text-[13px]">
					{note}
				</p>
			) : null}
			<ConfirmDialogRoot open={confirming} onOpenChange={open}>
				<ConfirmDialog
					id={make ? "make-instructor-dialog" : "remove-instructor-dialog"}
					testId={make ? "make-instructor-dialog" : "remove-instructor-dialog"}
					title={
						make ? `Make ${name} an instructor?` : `Remove instructor from ${name}?`
					}
					description={
						<>
							<span className="block">
								{make
									? "They can open the Course pages of courses they teach, from their next page load."
									: `They go back to ${roleText({ role: user.providerRole, grantedRole: null })}, from their next page load.`}
							</span>
							{change.error ? (
								<span
									className="mt-2 block text-status-error"
									role="alert"
									data-testid="instructor-change-error"
								>
									{errorText(change.error)}
								</span>
							) : null}
						</>
					}
					confirmLabel={make ? "Make instructor" : "Remove instructor"}
					pending={change.isPending}
					onConfirm={run}
				/>
			</ConfirmDialogRoot>
		</>
	);
}

/** Disable or enable the account (SPEC.md §6.4, §20.1). */
function AccountSection({ user, isSelf }: { user: AdminUser; isSelf: boolean }) {
	const toast = useToast();
	const wasDexLocal = useRef(user.dexLocal);

	// Remove takes the Dex buttons and their dialog away with it; focus then
	// goes to the panel heading rather than being lost (docs/archive/epics/EPIC-14.md ruling 22).
	useEffect(() => {
		const lost = document.activeElement === document.body || !document.activeElement;
		if (wasDexLocal.current && !user.dexLocal && lost) {
			document.getElementById("detail-title")?.focus();
		}
		wasDexLocal.current = user.dexLocal;
	}, [user.dexLocal]);
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
		<section aria-labelledby="detail-account" className="pk-detail-section">
			<h4 id="detail-account" className="pk-text-label m-0">
				Account
			</h4>
			<dl className="pk-dl">
				<dt>Role</dt>
				<dd data-testid="detail-role">{roleText(user)}</dd>
				<dt>Source</dt>
				<dd>{sourceText(user.issuer)}</dd>
				<dt>Last sign-in</dt>
				<dd data-testid="detail-last-sign-in">
					{user.lastLoginAt ? (
						<time
							dateTime={user.lastLoginAt}
							title={new Date(user.lastLoginAt).toLocaleString()}
						>
							{timeAgo(user.lastLoginAt, Date.now())}
						</time>
					) : (
						"Never"
					)}
				</dd>
				<dt>Username</dt>
				<dd className="pk-mono-small">{user.preferredUsername ?? "—"}</dd>
				<dt>Email</dt>
				<dd className="break-all" data-testid="detail-email">
					{user.email ?? "—"}
				</dd>
				<dt>Issuer</dt>
				<dd className="pk-mono-small break-all" data-testid="detail-issuer">
					{user.issuer ?? "—"}
				</dd>
			</dl>
			<div className="flex flex-wrap gap-2">
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
				<RoleChange user={user} isSelf={isSelf} />
				<InstructorChange user={user} />
				{user.dexLocal ? <DexUserActions user={user} isSelf={isSelf} /> : null}
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
		<div className="pk-actions items-start">
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
			{/* mt-6 is LABEL_CLASS's 18 px line plus FIELD_CLASS's 6 px gap, so Save
			    lines up with the input even when the hint or an error shows. */}
			<Button
				className="mt-6"
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
