import { POOL_WARN_PERCENT } from "@portikus/contracts";
import { Icon, Meter } from "@portikus/ui";
import { Link } from "@tanstack/react-router";
import { formatBytes, WARN_AT } from "../monitor/format.js";
import { timeAgo } from "../text.js";
import "../shell/status-bar.css";
import { attentionOf, usedPercent } from "./health/attention.js";
import { useHealthGlance } from "./health/queries.js";

/**
 * The student status bar's line at the foot of every admin page: the site,
 * then the host's vitals and one state that says whether anything needs a
 * look, each leading to Health (SPEC.md section 25.6).
 */
export function AdminStatusBar() {
	const health = useHealthGlance();
	const report = health.data;
	const host = report?.host ?? null;
	const running = report?.workspacesByState.running ?? 0;
	const total = report
		? Object.values(report.workspacesByState).reduce((sum, n) => sum + n, 0)
		: 0;
	const toLookAt = report ? attentionOf(report) : null;
	const attention = toLookAt?.count ?? 0;
	const guarded = toLookAt?.guard.length ?? 0;
	return (
		<footer className="pk-statusbar pk-admin-statusbar" data-testid="admin-status-bar">
			<div className="pk-statusbar-where">
				<span className="pk-statusbar-item pk-statusbar-path">
					{window.location.hostname}
				</span>
				{host?.image.serial ? (
					<span className="pk-statusbar-item pk-admin-statusbar-extra">
						Image {host.image.serial}
					</span>
				) : null}
			</div>
			{report ? (
				<div className="pk-statusbar-status">
					<div className="pk-statusbar-usage">
						<span className="pk-statusbar-item">
							<span className="pk-statusbar-label">Workspaces</span>
							{/* "3/5" reads as a date or a fraction, so a screen reader hears it in words. */}
							<span className="pk-num" aria-hidden="true">
								{running}/{total}
							</span>
							<span className="sr-only">
								{running} of {total} running
							</span>
						</span>
						{host ? (
							<>
								<span className="pk-statusbar-item pk-statusbar-meter pk-meter">
									<span className="pk-meter-label">Memory</span>
									<Meter
										label="Host memory"
										value={host.memory.usedBytes}
										max={host.memory.totalBytes}
										high={host.memory.totalBytes * WARN_AT}
										valueText={`${formatBytes(host.memory.usedBytes)} of ${formatBytes(host.memory.totalBytes)}`}
										shortText={`${usedPercent(host.memory.usedBytes, host.memory.totalBytes)}%`}
										className="pk-meter-line--slim"
									/>
								</span>
								<span className="pk-statusbar-item pk-statusbar-meter pk-meter">
									<span className="pk-meter-label">Storage</span>
									<Meter
										label="Storage pool"
										value={host.pool.usedBytes}
										max={host.pool.totalBytes}
										high={(host.pool.totalBytes * POOL_WARN_PERCENT) / 100}
										valueText={`${formatBytes(host.pool.usedBytes)} of ${formatBytes(host.pool.totalBytes)}`}
										shortText={`${usedPercent(host.pool.usedBytes, host.pool.totalBytes)}%`}
										className="pk-meter-line--slim"
									/>
								</span>
								<span className="pk-statusbar-item pk-admin-statusbar-extra">
									<span className="pk-statusbar-label">Load</span>
									<span className="pk-num">{host.loadAverage[0]?.toFixed(2)}</span>
								</span>
							</>
						) : null}
						{/* This report is not polled off the Health tab, so its age shows. */}
						{report.sampledAt ? (
							<span
								className="pk-statusbar-item pk-admin-statusbar-extra"
								data-testid="admin-status-age"
							>
								<span className="pk-statusbar-label">Sampled</span>
								<time dateTime={report.sampledAt}>
									{timeAgo(report.sampledAt, Date.now()).toLowerCase()}
								</time>
							</span>
						) : null}
					</div>
					<Link
						to="/admin/$tab"
						params={{ tab: "health" }}
						className="pk-statusbar-item pk-statusbar-plain pk-admin-statusbar-state"
						data-testid="admin-attention-pill"
						data-tone={attention > 0 ? "warning" : "ok"}
					>
						{attention > 0 ? (
							<Icon name="alert" size="sm" />
						) : (
							<span className="pk-dot pk-tone-running" aria-hidden="true" />
						)}
						{attention === 0
							? "All healthy"
							: guarded > 0 && toLookAt?.problems.length === 0
								? `${guarded} throttled or flagged`
								: `${attention} to look at`}
					</Link>
				</div>
			) : null}
		</footer>
	);
}
