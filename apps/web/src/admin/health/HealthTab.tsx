import type { HealthReport } from "@portikus/contracts";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { ApiError } from "../../api/request.js";
import { formatBytes } from "../../monitor/format.js";
import { AdminSection } from "../AdminSection.js";
import { shortTime } from "../shortTime.js";
import { KNOWN_STATES, WorkspaceStateBadge } from "../WorkspacesTab.js";
import { useHealth } from "./queries.js";
import { TrendsCard } from "./TrendsCard.js";

/** Pool or memory use at or above this share gets a warning (SPEC.md §19.2). */
export const WARN_RATIO = 0.8;

export function usedPercent(used: number, total: number): number {
	return total > 0 ? Math.round((used / total) * 100) : 0;
}

export function isNearlyFull(used: number, total: number): boolean {
	return total > 0 && used / total >= WARN_RATIO;
}

/** "3 minutes ago", for the age of the newest sample. */
export function sampleAge(sampledAt: string, now: number): string {
	const minutes = Math.floor((now - Date.parse(sampledAt)) / 60_000);
	if (minutes < 1) return "less than a minute ago";
	if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
	const hours = Math.floor(minutes / 60);
	return `${hours} hour${hours === 1 ? "" : "s"} ago`;
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
			<AdminSection title="Health">
				<p className="pk-error text-status-error" role="alert">
					{health.error instanceof ApiError
						? health.error.message
						: "Platform health could not be loaded."}
				</p>
			</AdminSection>
		);
	}
	return (
		<AdminSection title="Health">
			{health.data ? (
				<HealthView
					report={health.data}
					now={Date.now()}
					trends={<TrendsCard warnPercent={Math.round(WARN_RATIO * 100)} />}
				/>
			) : (
				<div aria-busy="true" data-testid="health-loading" />
			)}
		</AdminSection>
	);
}

/** States in the Workspaces tab's order, zeros included, then any newer ones. */
export function stateRows(byState: HealthReport["workspacesByState"]) {
	const extra = Object.keys(byState).filter((state) => !KNOWN_STATES.includes(state));
	return [...KNOWN_STATES, ...extra].map((state) => ({
		state,
		count: byState[state] ?? 0,
	}));
}

/**
 * Three rows (docs/EPIC-19.md ruling 9): Platform and Resource guard, then
 * the Trends card in full width, then Failures and Workspaces by state.
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
	return (
		<div className="flex flex-col gap-6" data-testid="health">
			{report.workerStale ? (
				<div
					className="pk-card border-status-warning bg-status-warning-soft p-4 text-status-warning"
					data-testid="health-worker-stale"
				>
					{/* Only the fixed text is live, so each refresh does not repeat the age. */}
					<strong role="alert">Worker not reporting.</strong>{" "}
					{report.sampledAt
						? `The last health sample was taken ${sampleAge(report.sampledAt, now)}.`
						: "No health sample has been taken yet."}
				</div>
			) : null}

			<div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-2">
				<section className="pk-card p-6" aria-labelledby="health-platform-title">
					<h3 className="pk-text-heading m-0" id="health-platform-title">
						Platform
					</h3>
					<dl className="mt-4 grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-[13px]">
						<dt className="pk-muted">Controller</dt>
						<dd className="m-0" data-testid="health-controller">
							{report.controller.reachable
								? "Reachable"
								: `Not reachable${report.controller.errorCode ? ` (${report.controller.errorCode})` : ""}`}
						</dd>
						<dt className="pk-muted">Last sample</dt>
						<dd className="m-0">
							{report.sampledAt ? sampleAge(report.sampledAt, now) : "None yet"}
						</dd>
						<dt className="pk-muted">Agents answering</dt>
						<dd className="m-0" data-testid="health-agents">
							{report.agents.answering} of {report.agents.running} running
						</dd>
						{host ? (
							<>
								<dt className="pk-muted">Load average</dt>
								<dd className="m-0">
									{host.loadAverage.map((load) => load.toFixed(2)).join(", ")} across{" "}
									{host.cpuCount} CPU{host.cpuCount === 1 ? "" : "s"}
								</dd>
								<dt className="pk-muted">Memory</dt>
								<dd className="m-0">
									<Usage
										testId="health-memory"
										name="Memory"
										used={host.memory.usedBytes}
										total={host.memory.totalBytes}
									/>
								</dd>
								<dt className="pk-muted">Storage pool</dt>
								<dd className="m-0">
									<Usage
										testId="health-pool"
										name="Storage pool"
										used={host.pool.usedBytes}
										total={host.pool.totalBytes}
									/>
								</dd>
								<dt className="pk-muted">Workspace limits</dt>
								<dd className="m-0">
									CPU {host.profileLimits.cpu ?? "not set"}, memory{" "}
									{host.profileLimits.memory ?? "not set"}, processes{" "}
									{host.profileLimits.processes ?? "not set"}
								</dd>
								<dt className="pk-muted">Current image</dt>
								<dd className="m-0" data-testid="health-image">
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
								<dt className="pk-muted">Host</dt>
								<dd className="m-0">No host figures in the newest sample.</dd>
							</>
						)}
					</dl>
				</section>

				<GuardList guard={report.guard} />
			</div>

			{trends}

			<div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-2">
				<section className="pk-card p-6" aria-labelledby="health-counts-title">
					<h3 className="pk-text-heading m-0" id="health-counts-title">
						Failures
					</h3>
					<table className="pk-table mt-4" data-testid="health-counts">
						<caption className="pk-text-label pk-muted text-left">
							Failures in the last 24 hours
						</caption>
						<tbody>
							{Object.entries(COUNT_LABELS).map(([key, label]) => (
								<tr key={key}>
									<th scope="row">{label}</th>
									<td className="pk-num">
										{report.last24h[key as keyof HealthReport["last24h"]]}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</section>
				<section className="pk-card p-6" aria-labelledby="health-states-title">
					<h3 className="pk-text-heading m-0" id="health-states-title">
						Workspaces by state
					</h3>
					<table className="pk-table mt-4" data-testid="health-states">
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
				</section>
			</div>
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
						at: entry.memoryFlag.at,
						average: `Memory ${Math.round(entry.memoryFlag.averagePercent)}% over ${entry.memoryFlag.windowMinutes} minutes`,
					},
				]
			: []),
	]);
}

/** Throttled and memory-flagged workspaces, each linking to its detail panel (ADR 0032). */
function GuardList({ guard }: { guard: HealthReport["guard"] }) {
	const rows = guardRows(guard);
	return (
		<section className="pk-card p-6" aria-labelledby="health-guard-title">
			<h3 className="pk-text-heading m-0" id="health-guard-title">
				Resource guard
			</h3>
			{rows.length === 0 ? (
				<p className="pk-muted m-0 mt-4 text-[13px]" data-testid="health-guard-empty">
					No workspace is throttled or flagged.
				</p>
			) : (
				<div className="pk-table-wrap mt-4">
					<table className="pk-table" data-testid="health-guard">
						<caption className="sr-only">Throttled and flagged workspaces</caption>
						<thead>
							<tr>
								<th scope="col">Owner</th>
								<th scope="col">State</th>
								<th scope="col">Since</th>
								<th scope="col">Average that set it</th>
							</tr>
						</thead>
						<tbody>
							{rows.map((row) => (
								<tr key={row.key}>
									<td>
										<Link
											to="/admin"
											search={{ tab: "workspaces", user: row.owner.id }}
											className="pk-link text-[var(--accent-text)] underline"
										>
											{row.owner.displayName}
										</Link>
									</td>
									<td>
										<span className="pk-tag pk-tag--warning">{row.which}</span>
									</td>
									<td>
										<time dateTime={row.at}>{shortTime(row.at)}</time>
									</td>
									<td>{row.average}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</section>
	);
}

function Usage({
	name,
	used,
	total,
	testId,
}: {
	name: string;
	used: number;
	total: number;
	testId: string;
}) {
	const warn = isNearlyFull(used, total);
	return (
		<span data-testid={testId}>
			{formatBytes(used)} of {formatBytes(total)} ({usedPercent(used, total)}%)
			{warn ? (
				<span className="pk-tag pk-tag--warning ml-2" data-testid={`${testId}-warning`}>
					{name} is over 80% full
				</span>
			) : null}
		</span>
	);
}
