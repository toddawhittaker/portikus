import {
	type HealthReport,
	POOL_FULL_PERCENT,
	POOL_WARN_PERCENT,
	poolFillPercent,
	WorkspaceState,
} from "@portikus/contracts";
import { Icon, Skeleton, Toggletip } from "@portikus/ui";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { ApiError } from "../../api/request.js";
import { formatBytes, WARN_AT } from "../../monitor/format.js";
import { shortTime } from "../../text.js";
import { AdminSection } from "../AdminSection.js";
import { Notice } from "../Notice.js";
import { WorkspaceStateBadge } from "../WorkspaceStateBadge.js";
import { useHealth } from "./queries.js";
import { TrendsCard } from "./TrendsCard.js";

export function usedPercent(used: number, total: number): number {
	return total > 0 ? Math.round((used / total) * 100) : 0;
}

export function isNearlyFull(used: number, total: number): boolean {
	return total > 0 && used / total >= WARN_AT;
}

/** "3 minutes ago", for the age of the newest sample. */
export function sampleAge(sampledAt: string, now: number): string {
	const minutes = Math.floor((now - Date.parse(sampledAt)) / 60_000);
	if (minutes < 1) return "less than a minute ago";
	if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
	const hours = Math.floor(minutes / 60);
	return `${hours} hour${hours === 1 ? "" : "s"} ago`;
}

/** The Health tab's intro under its heading. */
const HEALTH_INTRO = {
	id: "admin-health",
	helpAnchor: "admin-health",
	lead: "How the platform is doing right now and over time.",
	text: "Look here first when students report slow or failing workspaces.",
};

/** A figure's name with its help button; the negative margin keeps the 24 px button from growing the row. */
function Term({ label, help }: { label: string; help: string }) {
	return (
		<span className="-my-1 inline-flex items-center gap-1">
			{label}
			<Toggletip label={label}>{help}</Toggletip>
		</span>
	);
}

const COUNT_LABELS: Record<keyof HealthReport["last24h"], string> = {
	startFailures: "Start failures",
	stopFailures: "Stop failures",
	forcedStops: "Forced stops",
	provisionFailures: "Provision failures",
	controllerOutages: "Controller outages",
	signInFailures: "Failed or denied sign-ins",
	previewRefusals: "Refused previews",
};

/** The Health tab of the admin page (SPEC.md §25.6). */
export function HealthTab() {
	const health = useHealth();

	if (health.isError) {
		return (
			<AdminSection title="Health" intro={HEALTH_INTRO}>
				<p className="pk-error text-status-error" role="alert">
					{health.error instanceof ApiError
						? health.error.message
						: "Platform health could not be loaded."}
				</p>
			</AdminSection>
		);
	}
	return (
		<AdminSection title="Health" intro={HEALTH_INTRO}>
			{health.data ? (
				<HealthView
					report={health.data}
					now={Date.now()}
					trends={<TrendsCard warnPercent={Math.round(WARN_AT * 100)} />}
				/>
			) : (
				<div aria-busy="true" data-testid="health-loading">
					<Skeleton variant="block" height={280} />
				</div>
			)}
		</AdminSection>
	);
}

/** States in the Workspaces tab's order, zeros included, then any newer ones. */
export function stateRows(byState: HealthReport["workspacesByState"]) {
	const extra = Object.keys(byState).filter(
		(state) => !WorkspaceState.safeParse(state).success,
	);
	return [...WorkspaceState.options, ...extra].map((state) => ({
		state,
		count: byState[state] ?? 0,
	}));
}

/** A card in the At a glance grid: an h4 title, then its figures. */
function GlanceCard({
	id,
	title,
	className = "",
	children,
}: {
	id: string;
	title: string;
	/** Placement in the grid, or the attention border. */
	className?: string;
	children: ReactNode;
}) {
	return (
		<section
			className={`pk-card flex min-w-0 flex-col gap-3 p-5 ${className}`}
			aria-labelledby={`health-${id}-title`}
		>
			<h4 className="pk-text-compact m-0 font-semibold" id={`health-${id}-title`}>
				{title}
			</h4>
			{children}
		</section>
	);
}

/**
 * Top to bottom (SPEC.md section 25.6): the worker-stale banner; At a
 * glance, four cards in a grid (Platform, Failures in the last 24 hours,
 * Workspaces by state, Resource guard), Platform two columns wide when there
 * is room so its figures stay on one line; then the Trends card. A throttled
 * or flagged workspace is the one thing to act on, so the guard's card then
 * comes first, across the whole grid.
 */
export function HealthView({
	report,
	now,
	trends,
}: {
	report: HealthReport;
	now: number;
	trends?: ReactNode;
}) {
	const { host } = report;
	const guardFirst = guardRows(report.guard).length > 0;
	const guard = <GuardList guard={report.guard} />;
	const counts = Object.entries(COUNT_LABELS).map(
		([key, label]) =>
			[key, label, report.last24h[key as keyof HealthReport["last24h"]]] as const,
	);
	const noFailures = counts.every(([, , count]) => count === 0);
	return (
		<div className="flex flex-col gap-6" data-testid="health">
			{report.workerStale ? (
				<Notice tone="warning" testId="health-worker-stale">
					{/* Only the fixed text is live, so each refresh does not repeat the age. */}
					<strong role="alert">Worker not reporting.</strong>{" "}
					{report.sampledAt
						? `The last health sample was taken ${sampleAge(report.sampledAt, now)}.`
						: "No health sample has been taken yet."}
				</Notice>
			) : null}
			{report.packageUpdate ? (
				// The platform never upgrades itself.
				<div className="pk-card p-4" data-testid="health-package-update">
					<p className="m-0">
						Portikus <strong>{report.packageUpdate.available}</strong> is available.
						This server runs {report.packageUpdate.installed}. To install it, run{" "}
						<code className="pk-mono-small">
							sudo apt update &amp;&amp; sudo apt upgrade
						</code>{" "}
						on the server.
					</p>
				</div>
			) : null}

			<section className="flex flex-col gap-3" aria-labelledby="health-glance-title">
				<h3 className="pk-text-heading" id="health-glance-title">
					At a glance
				</h3>
				<div
					className="@container grid grid-cols-[repeat(auto-fit,minmax(min(100%,260px),1fr))] items-start gap-4"
					data-testid="health-glance"
				>
					{guardFirst ? guard : null}
					<GlanceCard
						id="platform"
						title="Platform"
						// Two 260 px tracks and their gap, so at 1280 px all three share a row.
						className="@min-[33.5rem]:col-span-2"
					>
						<dl className="pk-dl tabular-nums">
							<dt>Controller</dt>
							<dd data-testid="health-controller">
								{report.controller.reachable
									? "Reachable"
									: `Not reachable${report.controller.errorCode ? ` (${report.controller.errorCode})` : ""}`}
							</dd>
							<dt>Last sample</dt>
							<dd>
								{report.sampledAt ? sampleAge(report.sampledAt, now) : "None yet"}
							</dd>
							<dt>
								<Term
									label="Agents answering"
									help="Each running workspace has a small agent that serves its files and terminals. Fewer answering than running means some workspaces cannot be reached."
								/>
							</dt>
							<dd data-testid="health-agents">
								{report.agents.answering} of {report.agents.running} running
							</dd>
							{host ? (
								<>
									<dt>
										<Term
											label="Load average"
											help="How many processes wanted a CPU, averaged over 1, 5 and 15 minutes. Above the CPU count means work is waiting."
										/>
									</dt>
									<dd>
										{host.loadAverage.map((load) => load.toFixed(2)).join(", ")} across{" "}
										{host.cpuCount} CPU{host.cpuCount === 1 ? "" : "s"}
									</dd>
									<dt>Memory</dt>
									<dd>
										<Usage
											testId="health-memory"
											used={host.memory.usedBytes}
											total={host.memory.totalBytes}
											warning={
												isNearlyFull(host.memory.usedBytes, host.memory.totalBytes)
													? "Memory is over 80% full"
													: null
											}
										/>
									</dd>
									<dt>
										<Term
											label="Storage pool"
											help={`The disk space every workspace shares. This tab warns at ${POOL_WARN_PERCENT}% full, and at ${POOL_FULL_PERCENT}% new workspaces are refused until space is freed.`}
										/>
									</dt>
									<dd>
										<Usage
											testId="health-pool"
											used={host.pool.usedBytes}
											total={host.pool.totalBytes}
											warning={poolWarning(host.pool)}
										/>
									</dd>
									<dt>
										<Term
											label="Pool metadata"
											help="Bookkeeping space in the same pool. It can fill before the data does, with the same effect."
										/>
									</dt>
									<dd data-testid="health-pool-metadata">
										{host.pool.metadataPercent === null
											? "Not reported"
											: `${Math.round(host.pool.metadataPercent)}% used`}
									</dd>
									<dt>
										<Term
											label="Workspace limits"
											help="The site values every workspace gets unless its panel on the Users tab sets its own."
										/>
									</dt>
									<dd>
										CPU {host.profileLimits.cpu ?? "not set"}, memory{" "}
										{host.profileLimits.memory ?? "not set"}, processes{" "}
										{host.profileLimits.processes ?? "not set"}
									</dd>
									<dt>Current image</dt>
									<dd className="min-w-0 break-words" data-testid="health-image">
										{host.image.serial ?? "No version"}
										{host.image.fingerprint ? (
											<span className="pk-muted font-mono">
												{" "}
												({host.image.fingerprint.slice(0, 12)})
											</span>
										) : null}
									</dd>
								</>
							) : (
								<>
									<dt>Host</dt>
									<dd>No host figures in the newest sample.</dd>
								</>
							)}
						</dl>
					</GlanceCard>

					<GlanceCard id="counts" title="Failures, last 24 hours">
						{noFailures ? (
							<p
								className="m-0 flex items-center gap-1.5 text-status-running"
								data-testid="health-counts-none"
							>
								<Icon name="check" size="sm" />
								No failures in the last 24 hours
							</p>
						) : null}
						<table className="pk-table" data-testid="health-counts">
							<caption className="sr-only">Failures in the last 24 hours</caption>
							<tbody>
								{counts.map(([key, label, count]) => (
									<tr key={key}>
										<th scope="row" className="whitespace-normal">
											{label}
										</th>
										{/* A failure is the figure to look at; a zero steps back. */}
										<td
											className={`pk-num ${count > 0 ? "font-semibold text-status-error" : "text-ink-muted"}`}
										>
											{count}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</GlanceCard>

					<GlanceCard id="states" title="Workspaces by state">
						<table className="pk-table" data-testid="health-states">
							<caption className="sr-only">Workspaces by state</caption>
							<tbody>
								{stateRows(report.workspacesByState).map(({ state, count }) => (
									<tr key={state}>
										<th scope="row">
											<WorkspaceStateBadge
												state={state}
												desiredState={state}
												statusRole={false}
											/>
										</th>
										<td className="pk-num">{count}</td>
									</tr>
								))}
							</tbody>
						</table>
					</GlanceCard>
					{/* With nothing to act on, the guard's all-clear comes last. */}
					{guardFirst ? null : guard}
				</div>
			</section>

			{trends}
		</div>
	);
}

/** One row per throttle or memory flag, a workspace with both getting two. */
export function guardRows(guard: HealthReport["guard"]) {
	return guard.flatMap((entry) => [
		...(entry.cpuThrottle
			? [
					{
						key: `${entry.workspaceId}-cpu`,
						owner: entry.owner,
						which: "Throttled",
						held: entry.cpuThrottle.held !== undefined,
						at: entry.cpuThrottle.at,
						average: `CPU ${Math.round(entry.cpuThrottle.averagePercent)}% over ${entry.cpuThrottle.windowMinutes} minutes`,
					},
				]
			: []),
		...(entry.memoryFlag
			? [
					{
						key: `${entry.workspaceId}-memory`,
						owner: entry.owner,
						which: "High memory",
						held: false,
						at: entry.memoryFlag.at,
						average: `Memory ${Math.round(entry.memoryFlag.averagePercent)}% over ${entry.memoryFlag.windowMinutes} minutes`,
					},
				]
			: []),
	]);
}

/**
 * Throttled and memory-flagged workspaces, each linking to its detail panel
 * (ADR 0032).
 */
function GuardList({ guard }: { guard: HealthReport["guard"] }) {
	const rows = guardRows(guard);
	return (
		<GlanceCard
			id="guard"
			title="Resource guard"
			// Something to act on: across the grid, with the attention border.
			className={rows.length > 0 ? "pk-card--attention col-span-full" : ""}
		>
			{rows.length === 0 ? (
				<p className="pk-muted m-0 text-[13px]" data-testid="health-guard-empty">
					No workspace is throttled or flagged.
				</p>
			) : (
				<div className="pk-table-wrap">
					<table className="pk-table" data-testid="health-guard">
						<caption className="sr-only">Throttled and flagged workspaces</caption>
						<thead>
							<tr>
								<th scope="col">Owner</th>
								<th scope="col">State</th>
							</tr>
						</thead>
						<tbody>
							{rows.map((row) => (
								<tr key={row.key}>
									<td className="whitespace-normal py-1.5 align-top">
										<Link
											to="/admin/$tab"
											params={{ tab: "users" }}
											search={{ user: row.owner.id }}
											className="pk-link break-words"
										>
											{row.owner.displayName}
										</Link>
									</td>
									<td className="whitespace-normal py-1.5">
										<div className="pk-cell-stack gap-1">
											<span className="flex flex-wrap gap-1">
												<span className="pk-tag pk-tag--warning">{row.which}</span>
												{row.held ? (
													<span className="pk-tag pk-tag--warning">Held</span>
												) : null}
											</span>
											<span className="pk-muted text-[12px]">
												{row.average}, since{" "}
												<time dateTime={row.at}>{shortTime(row.at)}</time>
											</span>
										</div>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</GlanceCard>
	);
}

function Usage({
	used,
	total,
	testId,
	warning,
}: {
	used: number;
	total: number;
	testId: string;
	/** Shown as text beside the figures, so the warning never rests on colour. */
	warning: string | null;
}) {
	return (
		<span className="flex flex-wrap items-center gap-x-2 gap-y-1" data-testid={testId}>
			<span>
				{formatBytes(used)} of {formatBytes(total)} ({usedPercent(used, total)}%)
			</span>
			{warning ? (
				<span className="pk-tag pk-tag--warning" data-testid={`${testId}-warning`}>
					{warning}
				</span>
			) : null}
		</span>
	);
}

/** Names metadata when it, not data, is the figure over the line. */
function poolWarning(pool: {
	usedBytes: number;
	totalBytes: number;
	metadataPercent: number | null;
}): string | null {
	if (poolFillPercent(pool) < POOL_WARN_PERCENT) return null;
	const data = pool.totalBytes > 0 ? (pool.usedBytes / pool.totalBytes) * 100 : 0;
	return (pool.metadataPercent ?? 0) > data
		? `Storage pool metadata is over ${POOL_WARN_PERCENT}% full`
		: `Storage pool is over ${POOL_WARN_PERCENT}% full`;
}
