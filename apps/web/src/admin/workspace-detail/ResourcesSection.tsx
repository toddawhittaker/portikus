import type {
	AdminStorage,
	AdminUser,
	AdminWorkspaceDetail,
	QuotaConfig,
	WorkspaceLimits,
} from "@portikus/contracts";
import { Button, Icon, Skeleton, useToast } from "@portikus/ui";
import { useState } from "react";
import { errorText } from "../../api/request.js";
import { formatBytes, formatCpu } from "../../monitor/format.js";
import { STORAGE_CLASSES, type StorageClass } from "../../recovery/storage.js";
import { StorageMeterRow } from "../../shell/StorageMeters.js";
import { GraceDialog, graceValueText } from "../GraceDialog.js";
import { useSiteLimits } from "../health/queries.js";
import {
	type LimitKey,
	LimitsDialog,
	limitPhrase,
	type SiteLimits,
	siteLimits,
} from "../LimitsDialog.js";
import { QuotaDialog } from "../QuotaDialog.js";
import {
	usePlatformSettings,
	useUpdateLimits,
	useUpdateQuota,
	useUpdateUserSettings,
} from "../queries.js";
import { SECTION_HEADING } from "./shared.js";

function storageText(quota: { homeGiB: number; dockerGiB: number }): string {
	return `Home ${quota.homeGiB} GiB · Docker ${quota.dockerGiB} GiB`;
}

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

/** What an administrator can do when a class is nearly full; the student's steps are NEXT_STEP. */
export function adminStep(storageClass: StorageClass, ownerName: string): string {
	if (storageClass === "recovery") {
		return "Close to the limit. Older recovery points are removed automatically.";
	}
	const ask = storageClass === "home" ? "delete files" : "reset Docker";
	return `Close to the limit. Raise it with Edit quotas, or ask ${ownerName} to ${ask}.`;
}

/**
 * One meter per storage class against its limit (SPEC.md §18.3, §20.1), on
 * the student's StorageMeterRow, so both sides warn at storageLevel's
 * thresholds.
 */
export function AdminStorageMeters({
	storage,
	ownerName,
}: {
	storage: AdminStorage;
	ownerName: string;
}) {
	return (
		<div className="pk-meters">
			{STORAGE_CLASSES.map((key) => (
				<StorageMeterRow
					key={key}
					storageClass={key}
					figure={{
						usedBytes: storage[key].usedBytes,
						totalBytes: storage[key].limitBytes,
					}}
					step={adminStep(key, ownerName)}
				/>
			))}
		</div>
	);
}

/** "Not measured: the workspace is not running" and the like, when the agent sent no usage. */
function usageGap(agent: AdminWorkspaceDetail["agent"]): string {
	return agent === "stopped"
		? "Not measured: the workspace is not running"
		: "Not measured: the workspace agent is not answering";
}

type ResourceDialog = "quota" | "limits" | "grace";

/**
 * Storage, CPU and memory use, limits and the disconnect grace, each with its
 * editor in one row of actions. Only the grace shows for an
 * account without a workspace, because it belongs to the account.
 */
export function ResourcesSection({
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
			{detail?.storage ? (
				<AdminStorageMeters storage={detail.storage} ownerName={ownerName} />
			) : null}
			<dl className="pk-dl">
				{workspace && detail ? (
					<>
						<dt>Storage</dt>
						<dd className={EDIT_ROW}>
							<span data-testid="detail-quota">
								{storageText(workspace.quotaConfig)}
							</span>
							<EditButton
								testId="detail-quota-edit"
								label={`Edit quotas for ${ownerName}'s workspace`}
								onClick={() => setDialog("quota")}
							/>
						</dd>
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
						<dt>Limits</dt>
						<dd className={EDIT_ROW}>
							{/* Until the site's values arrive, a placeholder, so the line never
							    shows "CPUs (site value)" and then changes to "2 CPUs (site value)". */}
							{health.isPending && usesSiteLimit(detail.limitsConfig) ? (
								<Skeleton width="14rem" />
							) : (
								<span data-testid="detail-limits">
									{limitsText(detail.limitsConfig, site)}
								</span>
							)}
							<EditButton
								testId="detail-limits-edit"
								label={`Edit limits for ${ownerName}'s workspace`}
								onClick={() => setDialog("limits")}
							/>
						</dd>
					</>
				) : null}
				<dt>Disconnect grace</dt>
				<dd className={EDIT_ROW}>
					<span data-testid="detail-grace">
						{user.shutdownGraceSeconds !== null
							? graceValueText(user.shutdownGraceSeconds)
							: siteGrace === null
								? "Site setting"
								: `${graceValueText(siteGrace)} (site setting)`}
					</span>
					<EditButton
						testId="detail-grace-edit"
						label={`Edit disconnect grace for ${ownerName}`}
						onClick={() => setDialog("grace")}
					/>
				</dd>
			</dl>
			{/* One saved note at a time: both changes waiting share a line. */}
			{pendingNote(
				workspace !== null &&
					detail !== null &&
					quotaPending(workspace.quotaConfig, detail.quotaApplied),
				detail !== null && limitsPending(detail.limitsConfig, detail.limitsApplied),
			)}
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

/** True when any limit falls back to the site's profile. */
function usesSiteLimit(config: WorkspaceLimits | null): boolean {
	return (["cpu", "memoryMiB", "processes"] as const).some(
		(key) => config?.[key] === undefined,
	);
}

/** The one line saying a storage or limits change is saved and on its way. */
function pendingNote(quota: boolean, limits: boolean) {
	if (!quota && !limits) return null;
	const text =
		quota && limits
			? "Storage and limits saved. They take effect within a minute."
			: quota
				? "Storage saved. It takes effect within a minute."
				: "Limits saved. They take effect within a minute.";
	return (
		<p
			className="pk-text-compact pk-muted m-0 flex items-start gap-1.5"
			data-testid={limits ? "detail-limits-pending" : "detail-quota-pending"}
		>
			<Icon name="check" size="sm" className="mt-0.5 flex-none text-status-running" />
			{text}
		</p>
	);
}

/** A value with its Edit at the row's end. */
const EDIT_ROW = "flex min-w-0 items-start justify-between gap-2";

/** Each value's own Edit, beside what it changes, so the panel needs no row of edit buttons. */
function EditButton({
	testId,
	label,
	onClick,
}: {
	testId: string;
	label: string;
	onClick: () => void;
}) {
	return (
		<Button
			size="sm"
			variant="quiet"
			className="-my-1 flex-none"
			data-testid={testId}
			aria-label={label}
			aria-haspopup="dialog"
			onClick={onClick}
		>
			Edit
		</Button>
	);
}
