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
	WorkspaceLimits,
} from "@portikus/contracts";
import {
	Button,
	Checkbox,
	ConfirmDialog,
	ConfirmDialogRoot,
	type DesiredState,
	IconButton,
	resolveWorkspaceState,
	Toggletip,
	useToast,
	type WorkspaceState,
} from "@portikus/ui";
import { Link } from "@tanstack/react-router";
import type * as React from "react";
import { useEffect, useRef, useState } from "react";
import { formatBytes, formatCpu } from "../monitor/format.js";
import { PENDING_LABEL } from "../shell/StatusBar.js";
import { RestoreFromBackupDialog } from "./backups/BackupDialogs.js";
import { ConfirmByLabelDialog } from "./ConfirmByLabelDialog.js";
import { DexUserActions } from "./DexUserDialogs.js";
import { GraceDialog, graceValueText } from "./GraceDialog.js";
import { GuardDialog } from "./GuardDialog.js";
import { useSiteLimits } from "./health/queries.js";
import {
	type LimitKey,
	LimitsDialog,
	limitPhrase,
	type SiteLimits,
	siteLimits,
} from "./LimitsDialog.js";
import { imageText, isCourseAccount, roleText, sourceText } from "./markers.js";
import { ProcessesSection } from "./ProcessesSection.js";
import { QuotaDialog } from "./QuotaDialog.js";
import {
	useAdminWorkspace,
	useGuardClear,
	useLifecycleAction,
	usePlatformSettings,
	useRebuild,
	useRefreshUsersWhenDone,
	useReprovision,
	useResetDocker,
	useSetArchived,
	useSetDisabled,
	useSetGrantedAdmin,
	useSetGrantedInstructor,
	useUpdateGuard,
	useUpdateLimits,
	useUpdateQuota,
	useUpdateUserSettings,
} from "./queries.js";
import { errorText } from "./SettingsTab.js";
import { shortTime } from "./shortTime.js";
import {
	KNOWN_STATES,
	storageText,
	timeAgo,
	WorkspaceStateBadge,
} from "./WorkspacesTab.js";

/** Every section heading in the panel: small, bold and quiet (Epic 25, S5). */
export const SECTION_HEADING = "pk-text-compact m-0 font-semibold text-ink-muted";

/** Help text for the panel's toggletips, checked against the code (Epic 25, phase 2). */
export const PANEL_HELP = {
	reprovision:
		"Creates the workspace again after it failed. Its home folder and files are kept.",
	rebuild:
		"Recreates the workspace from the current image. Anything installed with sudo apt is lost. Projects, home and, unless you untick it, Docker data stay.",
	resetDocker:
		"Deletes every Docker image, container and volume in this workspace. Use it when Docker is stuck or full. Projects and home stay.",
	archive:
		"Stops the workspace and keeps it stopped until you unarchive it. Its files are kept. Use it at the end of a term.",
	storage:
		"Home holds projects and files. Docker holds images and volumes. Recovery holds recovery points. Home and Docker can only grow.",
	limits:
		"The most CPU, memory and processes this workspace may use. A site value comes from the workspace profile, shown on the Health tab.",
	grace:
		"How long this person's workspace keeps running after their last browser tab closes. Without an override, the site setting applies.",
	cpu: "Throttled means the workspace's CPU use averaged above the threshold for the whole window, so it now gets a smaller share. It gets full speed back after a quiet spell, or now with Lift throttle.",
	memory:
		"High memory is a flag only. Nothing is slowed. It stays until you clear it or the workspace stops.",
	lastInput:
		"The student's last key press in the page, file save or preview page load; a start counts too. Idle stop counts from here. Your own visits never count.",
	preview:
		"Reachable and forwarded ports open in a preview; forwarded means Portikus relays a port that listens only inside the workspace. Unknown ports are relayed when a preview first opens them. System marks the workspace's own services.",
	promote:
		"Makes this person an administrator from their next page load. Only SSO accounts can be given a role here.",
	makeInstructor:
		"Lets them open the Course page for courses they teach, from their next page load. Only SSO accounts can be given a role here; course accounts teach through their learning system.",
	disable:
		"Signs them out everywhere, closes their previews and stops their workspace. Nothing is deleted, and you can enable them again.",
} as const;

/** A definition term with its toggletip beside it. */
function TipTerm({
	children,
	label,
	tip,
}: {
	children: string;
	label: string;
	tip: string;
}) {
	return (
		<dt className="flex items-start gap-0.5">
			<span className="pt-0.5">{children}</span>
			<Toggletip label={label}>{tip}</Toggletip>
		</dt>
	);
}

/** A button with its toggletip, kept together inside an actions row. */
function WithTip({
	children,
	label,
	tip,
}: {
	children: React.ReactNode;
	label: string;
	/** Null shows the button alone, for the state the tip does not describe. */
	tip: string | null;
}) {
	return (
		<span className="inline-flex items-center gap-0.5">
			{children}
			{/* Always this wrapper, so the button keeps its focus when the tip goes. */}
			{tip === null ? null : <Toggletip label={label}>{tip}</Toggletip>}
		</span>
	);
}

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
	// Sections that need the detail wait for it; an account without a workspace has none to wait for.
	const settled = data !== null || workspaceId === null;

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
					<div className="flex min-w-0 flex-col gap-0.5">
						<h3
							id="detail-title"
							ref={headingRef}
							tabIndex={-1}
							className="pk-text-heading m-0 break-words outline-none"
						>
							{user.displayName}
						</h3>
						{user.workspace ? (
							<span className="pk-mono-small pk-muted break-all">
								{user.workspace.label}
							</span>
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
			{settled ? null : (
				<div className="pk-detail-section">
					{detail.isError ? (
						<p className="m-0 text-status-error" role="alert">
							{errorText(detail.error)}
						</p>
					) : (
						<p className="pk-text-compact pk-muted m-0" aria-busy="true">
							Loading…
						</p>
					)}
				</div>
			)}
			{data ? (
				<ErrorSection
					detail={data}
					ownerName={user.displayName}
					onReprovisioned={() => headingRef.current?.focus()}
				/>
			) : null}
			{settled ? (
				<>
					<WorkspaceSection detail={data} ownerName={user.displayName} />
					<ResourcesSection detail={data} user={user} />
				</>
			) : null}
			{data ? (
				<>
					<GuardSection detail={data} ownerName={user.displayName} />
					<ProcessesSection
						key={data.workspace.id}
						workspaceId={data.workspace.id}
						running={data.workspace.state === "running"}
						ownerName={user.displayName}
					/>
					<PortsSection detail={data} />
				</>
			) : null}
			<AccountSection user={user} isSelf={isSelf} />
			{data ? <AuditSection detail={data} /> : null}
		</section>
	);
}

export type LifecycleAction = "start" | "stop" | "restart";

/**
 * The lifecycle buttons that make sense now, and, during a transition, the
 * word for what the workspace is doing ("starting"). A transition keeps the
 * opposite action, so an admin can rescue a stuck workspace.
 */
export function lifecycleActions(
	state: string,
	desiredState: string,
): { actions: LifecycleAction[]; waiting: string | null } {
	if (!KNOWN_STATES.includes(state)) {
		return { actions: ["start", "stop", "restart"], waiting: null };
	}
	const resolved = resolveWorkspaceState(
		state as WorkspaceState,
		desiredState as DesiredState,
	);
	if (resolved.moving) {
		return {
			actions: desiredState === "stopped" ? ["start"] : ["stop", "restart"],
			waiting: resolved.label.toLowerCase(),
		};
	}
	return {
		actions: state === "running" ? ["stop", "restart"] : ["start"],
		waiting: null,
	};
}

/** The state badge and the lifecycle buttons that fit it, under the name (SPEC.md §20.1). */
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
	const { actions, waiting } = lifecycleActions(
		workspace.state,
		workspace.desiredState,
	);
	const archived = workspace.archivedAt !== null;
	const noteId = `lifecycle-note-${workspace.id}`;
	const archivedNote =
		archived && actions.includes("start")
			? "An archived workspace cannot start. Unarchive it first."
			: null;
	const note =
		[waiting ? `Waiting for the workspace to finish ${waiting}.` : null, archivedNote]
			.filter(Boolean)
			.join(" ") || null;
	const off = (action: LifecycleAction) => archived && action === "start";

	function runLifecycle(action: LifecycleAction) {
		if (lifecycle.isPending || off(action)) return;
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
			<div className="flex flex-wrap items-center gap-2">
				{/* Announces each state change while the panel refreshes. */}
				<span role="status" data-testid="detail-state">
					<WorkspaceStateBadge
						state={workspace.state}
						desiredState={workspace.desiredState}
						statusRole={false}
					/>
				</span>
				{archived ? <span className="pk-tag">Archived</span> : null}
			</div>
			<div className="pk-actions">
				{actions.map((action) => (
					<Button
						key={action}
						size="sm"
						data-testid={`detail-${action}`}
						aria-label={`${ACTION_LABEL[action]} ${ownerName}'s workspace`}
						aria-describedby={off(action) ? noteId : undefined}
						loading={lifecycle.isPending && lifecycle.variables?.action === action}
						aria-disabled={lifecycle.isPending || off(action) ? true : undefined}
						onClick={() => runLifecycle(action)}
					>
						{ACTION_LABEL[action]}
					</Button>
				))}
			</div>
			{note ? (
				<p
					id={noteId}
					className="pk-text-compact pk-muted m-0"
					data-testid="detail-lifecycle-note"
				>
					{note}
				</p>
			) : null}
		</>
	);
}

function ErrorSection({
	detail,
	ownerName,
	onReprovisioned,
}: {
	detail: AdminWorkspaceDetail;
	ownerName: string;
	onReprovisioned: () => void;
}) {
	const { workspace } = detail;
	const toast = useToast();
	const reprovision = useReprovision();
	if (!workspace.errorCode && !workspace.errorMessage) return null;

	function run() {
		if (reprovision.isPending) return;
		reprovision.mutate(
			{ workspaceId: workspace.id },
			{
				onSuccess: () => {
					toast.show({ tone: "success", title: "Re-provision requested" });
					// The section goes once the error clears, so focus moves to the panel heading.
					onReprovisioned();
				},
				onError: (error) =>
					toast.show({
						tone: "danger",
						title: "Could not re-provision the workspace",
						children: errorText(error),
					}),
			},
		);
	}

	return (
		<section aria-labelledby="detail-error" className="pk-detail-section">
			<h4 id="detail-error" className={SECTION_HEADING}>
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
			{workspace.state === "error" ? (
				<div className="pk-actions">
					<WithTip label="Re-provision" tip={PANEL_HELP.reprovision}>
						<Button
							size="sm"
							data-testid="detail-reprovision"
							aria-label={`Re-provision ${ownerName}'s workspace`}
							loading={reprovision.isPending}
							onClick={run}
						>
							Re-provision
						</Button>
					</WithTip>
				</div>
			) : null}
		</section>
	);
}

function PortsSection({ detail }: { detail: AdminWorkspaceDetail }) {
	return (
		<section aria-labelledby="detail-ports" className="pk-detail-section">
			<h4 id="detail-ports" className={SECTION_HEADING}>
				Ports and connections
			</h4>
			{detail.ports.length === 0 ? (
				<p className="pk-text-compact pk-muted m-0">No listening ports.</p>
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
								<th scope="col">
									<span className="inline-flex items-center gap-0.5">
										Preview
										<Toggletip label="Preview column">{PANEL_HELP.preview}</Toggletip>
									</span>
								</th>
							</tr>
						</thead>
						<tbody>
							{detail.ports.map((port) => (
								<tr key={port.port}>
									<td className="pk-num pk-mono-small">{port.port}</td>
									<td className="break-all">
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
			<p className="pk-text-compact m-0" data-testid="detail-sessions">
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
	);
}

/** The workspace's recent audit rows, with links to all of them and to its logs. */
function AuditSection({ detail }: { detail: AdminWorkspaceDetail }) {
	const { workspace } = detail;
	return (
		<section aria-labelledby="detail-audit" className="pk-detail-section">
			<h4 id="detail-audit" className={SECTION_HEADING}>
				Recent audit events
			</h4>
			{detail.recentAudit.length === 0 ? (
				<p className="pk-text-compact pk-muted m-0">No events yet.</p>
			) : (
				<ul className="pk-text-compact m-0 flex list-none flex-col gap-1 p-0">
					{detail.recentAudit.map((event) => (
						<li key={event.id} className="flex min-w-0 gap-2">
							<time dateTime={event.at} className="pk-muted flex-none">
								{shortTime(event.at)}
							</time>
							<span className="min-w-0 break-words">
								<span className="pk-mono-small">{event.action}</span> ·{" "}
								{event.actorName ?? event.actor}
							</span>
						</li>
					))}
				</ul>
			)}
			<div className="pk-actions pk-text-compact gap-x-4">
				<Link
					to="/admin"
					search={{ tab: "audit", workspace: workspace.id }}
					className="pk-link"
					data-testid="detail-all-events"
				>
					All events for this workspace
				</Link>
				<Link
					to="/admin"
					search={{ tab: "logs", workspace: workspace.id, since: "1h" }}
					className="pk-link"
					data-testid="detail-view-logs"
				>
					Logs for this workspace
				</Link>
			</div>
		</section>
	);
}

/** "Throttled since Sep 25, 14:02: …", or "Normal" (ADR 0032). */
export function throttleText(throttle: CpuThrottle | null): string {
	if (!throttle) return "Normal";
	return `Throttled since ${shortTime(throttle.at)}. It averaged ${Math.round(
		throttle.averagePercent,
	)}% over ${throttle.windowMinutes} minutes, above ${throttle.thresholdPercent}%, and now gets ${throttle.sharePercent}% of its CPU.`;
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

const LIMIT_NOUN: Record<LimitKey, string> = {
	cpu: "CPUs",
	memoryMiB: "Memory",
	processes: "Processes",
};

/**
 * "4 CPUs · 4 GiB memory (site value) · 2,000 processes (site value)": each
 * limit, marking the ones that come from the site's profile.
 */
export function limitsText(
	config: WorkspaceLimits | null,
	site: SiteLimits | null,
): string {
	return (["cpu", "memoryMiB", "processes"] as const)
		.map((key) => {
			const own = config?.[key];
			if (own !== undefined) return limitPhrase(key, own);
			const fallback = site?.[key] ?? null;
			return fallback === null
				? `${LIMIT_NOUN[key]} (site value)`
				: `${limitPhrase(key, fallback)} (site value)`;
		})
		.join(" · ");
}

/** True while the worker has not yet set the limits an administrator asked for. */
export function limitsPending(
	config: WorkspaceLimits | null,
	applied: WorkspaceLimits | null,
): boolean {
	return (["cpu", "memoryMiB", "processes"] as const).some(
		(key) => config?.[key] !== applied?.[key],
	);
}

/** Throttle and memory flag, the guard's values and the last input (ADR 0032, SPEC.md §20.1). */
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
	const site = settings.data
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
				className={`${SECTION_HEADING} outline-none`}
			>
				Resource guard
			</h4>
			<dl className="pk-dl">
				<TipTerm label="CPU throttle" tip={PANEL_HELP.cpu}>
					CPU
				</TipTerm>
				<dd
					className={cpuThrottle ? "text-status-warning" : undefined}
					data-testid="detail-guard-cpu"
				>
					{throttleText(cpuThrottle)}
				</dd>
				<TipTerm label="High memory" tip={PANEL_HELP.memory}>
					Memory
				</TipTerm>
				<dd
					className={memoryFlag ? "text-status-warning" : undefined}
					data-testid="detail-guard-memory"
				>
					{memoryFlagText(memoryFlag)}
				</dd>
				<TipTerm label="Last input" tip={PANEL_HELP.lastInput}>
					Last input (idle stop)
				</TipTerm>
				<dd data-testid="detail-last-activity">
					{workspace.lastActivityAt ? (
						<time dateTime={workspace.lastActivityAt}>
							{shortTime(workspace.lastActivityAt)}
						</time>
					) : (
						"None recorded"
					)}
				</dd>
			</dl>
			<ul
				className="pk-text-compact m-0 flex list-none flex-col gap-0.5 p-0"
				data-testid="detail-guard-limits"
			>
				{effectiveGuardText(detail.effectiveGuard, detail.guardConfig).map((line) => (
					<li key={line}>{line}</li>
				))}
			</ul>
			<div className="pk-actions">
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
					aria-label={`Guard settings for ${ownerName}'s workspace`}
					onClick={() => setEditing(true)}
				>
					Guard settings…
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
					defaults={site}
					ownerName={ownerName}
					pending={update.isPending}
					serverError={update.error ? errorText(update.error) : null}
					onSave={(body) =>
						update.mutate(
							{ workspaceId: workspace.id, body },
							{
								onSuccess: () => {
									toast.show({ tone: "success", title: "Guard settings saved" });
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

/** "Not measured: the workspace is not running" and the like, when the agent sent no usage. */
export function usageGap(agent: AdminWorkspaceDetail["agent"]): string {
	return agent === "stopped"
		? "Not measured: the workspace is not running"
		: "Not measured: the workspace agent is not answering";
}

type ResourceDialog = "quota" | "limits" | "grace";

/**
 * Storage, CPU and memory use, limits and the disconnect grace, each with its
 * editor in one row of actions (Epic 25, R2). Only the grace shows for an
 * account without a workspace, because it belongs to the account.
 */
function ResourcesSection({
	detail,
	user,
}: {
	detail: AdminWorkspaceDetail | null;
	user: AdminUser;
}) {
	const toast = useToast();
	const quota = useUpdateQuota();
	const limits = useUpdateLimits();
	const grace = useUpdateUserSettings();
	const settings = usePlatformSettings();
	const health = useSiteLimits();
	const [dialog, setDialog] = useState<ResourceDialog | null>(null);
	const ownerName = user.displayName;
	const site = siteLimits(health.data?.host);
	const siteGrace = settings.data?.shutdownGraceSeconds ?? null;
	const workspace = detail?.workspace ?? null;
	const usage = detail?.usage ?? null;

	function close(reset: () => void) {
		return (open: boolean) => {
			if (!open) {
				reset();
				setDialog(null);
			}
		};
	}

	return (
		<section aria-labelledby="detail-resources" className="pk-detail-section">
			<h4 id="detail-resources" className={SECTION_HEADING}>
				Resources
			</h4>
			{detail?.storage ? <StorageMeters storage={detail.storage} /> : null}
			<dl className="pk-dl">
				{workspace && detail ? (
					<>
						<TipTerm label="Storage" tip={PANEL_HELP.storage}>
							Storage
						</TipTerm>
						<dd data-testid="detail-quota">{storageText(workspace.quotaConfig)}</dd>
						{usage ? (
							<>
								{detail.storage ? null : (
									<>
										<dt>Home disk</dt>
										<dd data-testid="detail-disk-use">
											{formatBytes(usage.disk.usedBytes)} of{" "}
											{formatBytes(usage.disk.totalBytes)}
										</dd>
									</>
								)}
								<dt>CPU use</dt>
								<dd data-testid="detail-cpu-use">{formatCpu(usage.cpuPercent)}</dd>
								<dt>Memory use</dt>
								<dd data-testid="detail-memory-use">
									{formatBytes(usage.memory.usedBytes)} of{" "}
									{formatBytes(usage.memory.totalBytes)}
								</dd>
							</>
						) : (
							<>
								<dt>Use</dt>
								<dd data-testid="detail-usage">{usageGap(detail.agent)}</dd>
							</>
						)}
						<TipTerm label="Limits" tip={PANEL_HELP.limits}>
							Limits
						</TipTerm>
						<dd data-testid="detail-limits">{limitsText(detail.limitsConfig, site)}</dd>
					</>
				) : null}
				<TipTerm label="Disconnect grace" tip={PANEL_HELP.grace}>
					Disconnect grace
				</TipTerm>
				<dd data-testid="detail-grace">
					{user.shutdownGraceSeconds !== null
						? graceValueText(user.shutdownGraceSeconds)
						: siteGrace === null
							? "Site setting"
							: `${graceValueText(siteGrace)} (site setting)`}
				</dd>
			</dl>
			{workspace &&
			detail &&
			quotaPending(workspace.quotaConfig, detail.quotaApplied) ? (
				<p
					className="pk-text-compact m-0 text-status-warning"
					data-testid="detail-quota-pending"
				>
					Storage saved. It takes effect within a minute.
				</p>
			) : null}
			{detail && limitsPending(detail.limitsConfig, detail.limitsApplied) ? (
				<p
					className="pk-text-compact m-0 text-status-warning"
					data-testid="detail-limits-pending"
				>
					Limits saved. They take effect within a minute.
				</p>
			) : null}
			<div className="pk-actions">
				{workspace ? (
					<>
						<Button
							size="sm"
							data-testid="detail-quota-edit"
							aria-label={`Edit quotas for ${ownerName}'s workspace`}
							onClick={() => setDialog("quota")}
						>
							Edit quotas…
						</Button>
						<Button
							size="sm"
							data-testid="detail-limits-edit"
							aria-label={`Edit limits for ${ownerName}'s workspace`}
							onClick={() => setDialog("limits")}
						>
							Edit limits…
						</Button>
					</>
				) : null}
				<Button
					size="sm"
					data-testid="detail-grace-edit"
					aria-label={`Edit disconnect grace for ${ownerName}`}
					onClick={() => setDialog("grace")}
				>
					Edit disconnect grace…
				</Button>
			</div>
			{workspace && dialog === "quota" ? (
				<QuotaDialog
					open
					onOpenChange={close(quota.reset)}
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
									setDialog(null);
								},
							},
						)
					}
				/>
			) : null}
			{workspace && detail && dialog === "limits" ? (
				<LimitsDialog
					open
					onOpenChange={close(limits.reset)}
					current={detail.limitsConfig}
					ownerName={ownerName}
					site={site}
					pending={limits.isPending}
					serverError={limits.error ? errorText(limits.error) : null}
					onSave={(body) =>
						limits.mutate(
							{ workspaceId: workspace.id, body },
							{
								onSuccess: () => {
									toast.show({ tone: "success", title: "Limits saved" });
									setDialog(null);
								},
							},
						)
					}
				/>
			) : null}
			{dialog === "grace" ? (
				<GraceDialog
					open
					onOpenChange={close(grace.reset)}
					current={user.shutdownGraceSeconds}
					siteSeconds={siteGrace}
					ownerName={ownerName}
					pending={grace.isPending}
					serverError={grace.error ? errorText(grace.error) : null}
					onSave={(seconds) =>
						grace.mutate(
							{ userId: user.id, body: { shutdownGraceSeconds: seconds } },
							{
								onSuccess: () => {
									toast.show({ tone: "success", title: "Disconnect grace saved" });
									setDialog(null);
								},
							},
						)
					}
				/>
			) : null}
		</section>
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

/** Image, Rebuild, Reset Docker and Archive (SPEC.md section 20.1). */
function WorkspaceSection({
	detail,
	ownerName,
}: {
	detail: AdminWorkspaceDetail | null;
	ownerName: string;
}) {
	return (
		<section aria-labelledby="detail-workspace" className="pk-detail-section">
			<h4 id="detail-workspace" className={SECTION_HEADING}>
				Workspace
			</h4>
			{detail ? (
				<WorkspaceActions detail={detail} ownerName={ownerName} />
			) : (
				<p className="pk-text-compact pk-muted m-0">This account has no workspace.</p>
			)}
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
	const [restoring, setRestoring] = useState<string | null>(null);
	const archived = workspace.archivedAt !== null;
	// A second request would only answer 409 OPERATION_PENDING (ADR 0021).
	const operationPending = workspace.pendingOperation !== null;
	useRefreshUsersWhenDone(workspace.pendingOperation);
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
				<dd className="pk-mono-small break-all">{imageText(detail.image)}</dd>
			</dl>
			<div className="pk-actions">
				<Button
					size="sm"
					data-testid="detail-restore"
					aria-label={`Restore from backup: ${ownerName}'s workspace`}
					aria-haspopup="dialog"
					onClick={() => setRestoring(workspace.id)}
				>
					Restore from backup…
				</Button>
				<WithTip label="Rebuild workspace" tip={PANEL_HELP.rebuild}>
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
				</WithTip>
				<WithTip label="Reset Docker" tip={PANEL_HELP.resetDocker}>
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
				</WithTip>
				<WithTip label="Archive workspace" tip={archived ? null : PANEL_HELP.archive}>
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
				</WithTip>
			</div>
			<RestoreFromBackupDialog
				workspaceId={restoring}
				onClose={() => setRestoring(null)}
			/>
			{workspace.pendingOperation ? (
				<p
					id={pendingId}
					className="pk-text-compact pk-muted m-0"
					data-testid="pending-operation"
				>
					{PENDING_LABEL[workspace.pendingOperation]} Rebuild and Reset Docker are off
					until it finishes.
				</p>
			) : null}
			{note ? (
				<p
					id={noteId}
					className="pk-text-compact pk-muted m-0"
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
			<WithTip
				label={promote ? "Promote" : "Demote"}
				tip={promote ? PANEL_HELP.promote : null}
			>
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
			</WithTip>
			{note ? (
				<p id={noteId} className="pk-text-compact pk-muted m-0 w-full">
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
					destructive={!promote}
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
			<WithTip
				label={make ? "Make instructor" : "Remove instructor"}
				tip={make ? PANEL_HELP.makeInstructor : null}
			>
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
			</WithTip>
			{note ? (
				<p id={noteId} className="pk-text-compact pk-muted m-0 w-full">
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
					destructive={false}
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
			<h4 id="detail-account" className={SECTION_HEADING}>
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
				<dd className="pk-mono-small break-all">{user.preferredUsername ?? "—"}</dd>
				<dt>Email</dt>
				<dd className="break-all" data-testid="detail-email">
					{user.email ?? "—"}
				</dd>
				<dt>Issuer</dt>
				<dd className="pk-mono-small break-all" data-testid="detail-issuer">
					{user.issuer ?? "—"}
				</dd>
			</dl>
			<Link
				to="/admin"
				search={{ tab: "logs", user: user.id }}
				className="pk-link pk-text-compact justify-self-start"
				data-testid="detail-user-logs"
			>
				View this user's logs
			</Link>
			<div className="pk-actions">
				<RoleChange user={user} isSelf={isSelf} />
				<InstructorChange user={user} />
				{user.dexLocal ? <DexUserActions user={user} isSelf={isSelf} /> : null}
			</div>
			{/* Disabling is the heaviest action, so it sits alone and last. */}
			<div className="pk-actions">
				<WithTip
					label={disabled ? "Enable account" : "Disable account"}
					tip={disabled ? null : PANEL_HELP.disable}
				>
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
				</WithTip>
			</div>
			{isSelf ? (
				<p id={selfNoteId} className="pk-text-compact pk-muted m-0">
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
