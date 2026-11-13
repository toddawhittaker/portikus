import {
	type HealthReport,
	POOL_FULL_PERCENT,
	POOL_WARN_PERCENT,
	WorkspaceState,
} from "@portikus/contracts";
import { buttonClass, Icon, Skeleton, Toggletip } from "@portikus/ui";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { ApiError } from "../../api/request.js";
import { QuietState } from "../../common/QuietState.js";
import { formatBytes, WARN_AT } from "../../monitor/format.js";
import { shortTime } from "../../text.js";
import { AdminSection } from "../AdminSection.js";
import { Notice } from "../Notice.js";
import { WorkspaceStateBadge } from "../WorkspaceStateBadge.js";
import {
	attentionOf,
	isNearlyFull,
	MEMORY_WARNING,
	poolWarning,
	usedPercent,
} from "./attention.js";
import { useHealth } from "./queries.js";
import { TrendsCard } from "./TrendsCard.js";
import "./health.css";

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

/** A card on the Health page: an h4 title, then its figures. */
function GlanceCard({
	id,
	title,
	className = "",
	aside,
	children,
}: {
	id: string;
	title: string;
	className?: string;
	/** Beside the title, such as a total. */
	aside?: ReactNode;
	children: ReactNode;
}) {
	return (
		<section
			className={`pk-card flex min-w-0 flex-col gap-3 p-5 ${className}`}
			aria-labelledby={`health-${id}-title`}
		>
			<div className="flex items-baseline justify-between gap-3">
				<h4 className="pk-text-heading" id={`health-${id}-title`}>
					{title}
				</h4>
				{aside}
			</div>
			{children}
		</section>
	);
}

/**
 * An incident briefing, top to bottom (SPEC.md section 25.6): what needs a
 * person now, with links into Users, Logs and Audit; then the four vitals;
 * then failures and workspace states side by side; the platform's facts; and
 * the trends that explain how it got here.
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
	const counts = Object.entries(COUNT_LABELS).map(
		([key, label]) =>
			[key, label, report.last24h[key as keyof HealthReport["last24h"]]] as const,
	);
	const failures = counts.reduce((sum, [, , count]) => sum + count, 0);
	const noFailures = failures === 0;
	const states = stateRows(report.workspacesByState);
	const total = states.reduce((sum, row) => sum + row.count, 0);
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

			<section className="flex flex-col gap-4" aria-labelledby="health-glance-title">
				<h3 className="sr-only" id="health-glance-title">
					At a glance
				</h3>
				<Attention report={report} now={now} />
				<HealthStats report={report} />
				<div className="pk-health-pair" data-testid="health-glance">
					<GlanceCard
						id="counts"
						title="Failures, last 24 hours"
						aside={
							<span className="pk-num text-[13px] text-ink-muted">
								{failures === 1 ? "1 failure" : `${failures} failures`}
							</span>
						}
					>
						{noFailures ? (
							<QuietState
								testId="health-counts-none"
								title="No failures in the last 24 hours"
								detail="Starts, stops, sign-ins, previews and the controller all ran clean."
							/>
						) : null}
						<table
							className={`pk-table pk-health-counts${noFailures ? " sr-only" : ""}`}
							data-testid="health-counts"
						>
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
						{noFailures ? null : (
							<Link
								to="/admin/$tab"
								params={{ tab: "logs" }}
								search={{ level: "error,warn", since: "24h" }}
								className="pk-nav-link"
							>
								Errors and warnings in Logs
								<Icon name="chevron-right" size="sm" />
							</Link>
						)}
					</GlanceCard>

					<GlanceCard
						id="states"
						title="Workspaces by state"
						aside={
							<span className="pk-num text-[13px] text-ink-muted">{total} in all</span>
						}
					>
						<StateBar rows={states} total={total} />
						<table className="pk-state-legend" data-testid="health-states">
							<caption className="sr-only">Workspaces by state</caption>
							<tbody>
								{states
									.filter((row) => row.count > 0 || row.state === "error")
									.map(({ state, count }) => (
										<tr key={state}>
											<th scope="row">
												{/* No errors is good news, so it stays quiet rather than red. */}
												{count === 0 ? (
													<span className="pk-state-zero">Error</span>
												) : (
													<WorkspaceStateBadge
														state={state}
														desiredState={state}
														statusRole={false}
													/>
												)}
											</th>
											<td className={count === 0 ? "pk-num text-ink-muted" : "pk-num"}>
												{count}
											</td>
										</tr>
									))}
							</tbody>
						</table>
					</GlanceCard>
				</div>
				<GlanceCard id="platform" title="Platform" className="@container">
					<dl className="pk-kv pk-kv--pairs">
						<dt>Controller</dt>
						<dd data-testid="health-controller">
							{controllerDetail(report.controller)}
						</dd>
						<dt>Last sample</dt>
						<dd>{report.sampledAt ? sampleAge(report.sampledAt, now) : "None yet"}</dd>
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
								<dd className="pk-num-inline">
									{host.loadAverage.map((load) => load.toFixed(2)).join(", ")} across{" "}
									{host.cpuCount} CPU{host.cpuCount === 1 ? "" : "s"}
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
										<span className="pk-muted font-mono text-[12px]">
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
			</section>

			{trends}
		</div>
	);
}

/** The workspaces as one bar, a segment per state with any. A picture of the list beside it. */
function StateBar({
	rows,
	total,
}: {
	rows: { state: string; count: number }[];
	total: number;
}) {
	if (total === 0) return null;
	return (
		<div className="pk-state-bar" aria-hidden={true}>
			{rows
				.filter((row) => row.count > 0)
				.map((row) => (
					<span
						key={row.state}
						data-state={row.state}
						style={{ flexGrow: row.count }}
					/>
				))}
		</div>
	);
}

/**
 * The four figures to read first, each a tile with its number large and,
 * for a capacity, the meter the student status bar uses.
 */
/** The Platform card's line: whether the controller answers, and the error code when it does not. */
function controllerDetail(controller: HealthReport["controller"]): string {
	if (controller === null) return "Unknown";
	if (controller.reachable) return "Reachable";
	return controller.errorCode
		? `Not reachable (${controller.errorCode})`
		: "Not reachable";
}

/** The stat tile's footer when every agent answers. */
function controllerSummary(controller: HealthReport["controller"]): string {
	if (controller === null) return "Controller state unknown";
	return controller.reachable ? "Controller reachable" : "Controller not reachable";
}

function HealthStats({ report }: { report: HealthReport }) {
	const { host } = report;
	const states = stateRows(report.workspacesByState);
	const total = states.reduce((sum, row) => sum + row.count, 0);
	const running = report.workspacesByState.running ?? 0;
	const silent = report.agents.running - report.agents.answering;
	return (
		<dl className="pk-stats pk-stats--strip" data-testid="health-stats">
			<div className="pk-stat">
				<dt className="pk-stat-label">Workspaces running</dt>
				<dd className="pk-stat-value">
					{running}
					<span className="pk-stat-of"> of {total}</span>
				</dd>
				<dd className="pk-stat-foot">{total - running} not running</dd>
			</div>
			<div className="pk-stat" data-tone={silent > 0 ? "warning" : undefined}>
				<dt className="pk-stat-label">Agents answering</dt>
				<dd className="pk-stat-value">
					{report.agents.answering}
					<span className="pk-stat-of"> of {report.agents.running}</span>
				</dd>
				<dd className="pk-stat-foot">
					{silent > 0
						? `${silent} not answering`
						: controllerSummary(report.controller)}
				</dd>
			</div>
			{host ? (
				<>
					<CapacityStat
						label="Memory"
						testId="health-memory"
						used={host.memory.usedBytes}
						total={host.memory.totalBytes}
						high={WARN_AT}
						warning={
							isNearlyFull(host.memory.usedBytes, host.memory.totalBytes)
								? MEMORY_WARNING
								: null
						}
					/>
					<CapacityStat
						label="Storage pool"
						testId="health-pool"
						used={host.pool.usedBytes}
						total={host.pool.totalBytes}
						high={POOL_WARN_PERCENT / 100}
						warning={poolWarning(host.pool)}
						help={`The disk space every workspace shares. This tab warns at ${POOL_WARN_PERCENT}% full, and at ${POOL_FULL_PERCENT}% new workspaces are refused until space is freed.`}
					/>
				</>
			) : null}
		</dl>
	);
}

function CapacityStat({
	label,
	testId,
	used,
	total,
	high,
	warning,
	help,
}: {
	label: string;
	testId: string;
	/** What the figure means, behind a help button beside its label. */
	help?: string;
	used: number;
	total: number;
	/** The share of the total past which the bar turns amber. */
	high: number;
	warning: string | null;
}) {
	return (
		<div className="pk-stat" data-tone={warning ? "warning" : undefined}>
			<dt className="pk-stat-label">
				{help ? <Term label={label} help={help} /> : label}
			</dt>
			<dd className="pk-stat-value">
				{usedPercent(used, total)}
				<span className="pk-stat-of">%</span>
			</dd>
			<dd className="pk-stat-foot">
				{/* The figures beside it carry the value, so the bar is only a picture of them. */}
				<meter
					className="pk-meter-bar pk-stat-meter"
					aria-hidden="true"
					min={0}
					max={total > 0 ? total : 1}
					value={Math.max(used, 0)}
					high={total * high}
					optimum={0}
				/>
				<Usage testId={testId} used={used} total={total} warning={warning} />
			</dd>
		</div>
	);
}

/**
 * What needs a person now, most pressing first: each throttled or flagged
 * workspace with links into Users, Logs and Audit, then anything else the
 * report marks as wrong. With nothing to act on, one calm all-clear row.
 */
function Attention({ report, now }: { report: HealthReport; now: number }) {
	const { guard: rows, problems, count } = attentionOf(report);
	return (
		<section
			className="flex flex-col gap-2"
			aria-labelledby="health-guard-title"
			data-testid="health-verdict"
		>
			<div className="flex items-baseline gap-2">
				<h4 className="pk-overline" id="health-guard-title">
					{count > 0 ? "Needs attention" : "Resource guard"}
				</h4>
				{count > 0 ? (
					<span className="pk-overline pk-num">
						<span className="sr-only">, </span>
						<span data-testid="health-attention-count">{count}</span>
						<span className="sr-only">{count === 1 ? " item" : " items"}</span>
					</span>
				) : null}
			</div>
			{count === 0 ? (
				<QuietState
					testId="health-guard-empty"
					title="All systems healthy"
					detail={`No failures, throttles or warnings. Checked ${report.sampledAt ? sampleAge(report.sampledAt, now) : "when the next sample arrives"}.`}
				/>
			) : (
				<div
					className="pk-attention"
					data-tone={rows.length > 0 ? undefined : "warning"}
				>
					{rows.length > 0 ? (
						<table className="pk-attention-table" data-testid="health-guard">
							<caption className="sr-only">Throttled and flagged workspaces</caption>
							<thead className="sr-only">
								<tr>
									<th scope="col">Owner</th>
									<th scope="col">State</th>
									<th scope="col">Look closer</th>
								</tr>
							</thead>
							<tbody>
								{rows.map((row) => (
									<tr key={row.key}>
										<td className="pk-attention-who">
											<Icon name="alert" className="pk-attention-icon" />
											<Link
												to="/admin/$tab"
												params={{ tab: "users" }}
												search={{ user: row.owner.id }}
												className="pk-entity-link break-words"
											>
												{row.owner.displayName}
											</Link>
										</td>
										<td className="pk-attention-text">
											<span className="flex flex-wrap items-center gap-1.5">
												<span className="pk-tag pk-tag--warning">{row.which}</span>
												{row.held ? (
													<span className="pk-tag pk-tag--warning">Held</span>
												) : null}
											</span>
											<span className="pk-attention-detail">
												{row.average}, since{" "}
												<time dateTime={row.at}>{shortTime(row.at)}</time>
											</span>
										</td>
										<td className="pk-attention-actions">
											<Link
												to="/admin/$tab"
												params={{ tab: "logs" }}
												search={{ workspace: row.workspaceId }}
												className={buttonClass("quiet", "sm")}
												aria-label={`Logs for ${row.owner.displayName}'s workspace`}
											>
												Logs
											</Link>
											<Link
												to="/admin/$tab"
												params={{ tab: "audit" }}
												search={{ workspace: row.workspaceId }}
												className={buttonClass("quiet", "sm")}
												aria-label={`Audit for ${row.owner.displayName}'s workspace`}
											>
												Audit
											</Link>
											<Link
												to="/admin/$tab"
												params={{ tab: "users" }}
												search={{ user: row.owner.id }}
												className={buttonClass("secondary", "sm")}
												aria-label={`Inspect ${row.owner.displayName}'s workspace`}
											>
												Inspect
											</Link>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					) : null}
					{problems.length > 0 ? (
						<ul className="pk-attention-list">
							{problems.map((problem) => (
								<li key={problem.text} className="pk-attention-row">
									<span className="pk-attention-who">
										<Icon name="alert" className="pk-attention-icon" />
										<span className="font-semibold">{problem.text}</span>
									</span>
									<span className="pk-attention-actions">
										<Link
											to="/admin/$tab"
											params={{ tab: problem.tab }}
											search={problem.search}
											className={buttonClass("quiet", "sm")}
										>
											{problem.action}
										</Link>
									</span>
								</li>
							))}
						</ul>
					) : null}
				</div>
			)}
		</section>
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
