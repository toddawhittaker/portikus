import type {
	AdminStorage,
	AdminUser,
	AdminWorkspaceDetail,
	QuotaConfig,
	WorkspaceLimits,
} from "@portikus/contracts";
import { Button, useToast } from "@portikus/ui";
import { useState } from "react";
import { errorText } from "../../api/request.js";
import { formatBytes, formatCpu } from "../../monitor/format.js";
import { STORAGE_CLASSES } from "../../recovery/storage.js";
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
import { storageText } from "../WorkspacesTab.js";
import { PANEL_HELP, SECTION_HEADING, TipTerm } from "./shared.js";

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

/** One meter per storage class against its limit (SPEC.md §18.3, §20.1). */
function StorageMeters({ storage }: { storage: AdminStorage }) {
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
				/>
			))}
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
