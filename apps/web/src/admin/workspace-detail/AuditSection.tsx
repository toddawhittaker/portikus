import type { AdminWorkspaceDetail } from "@portikus/contracts";
import { Link } from "@tanstack/react-router";
import { shortTime } from "../../text.js";
import { SECTION_HEADING } from "./shared.js";

/** The workspace's recent audit rows, with links to all of them and to its logs. */
export function AuditSection({ detail }: { detail: AdminWorkspaceDetail }) {
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
					to="/admin/$tab"
					params={{ tab: "audit" }}
					search={{ workspace: workspace.id }}
					className="pk-link"
					data-testid="detail-all-events"
				>
					All events for this workspace
				</Link>
				<Link
					to="/admin/$tab"
					params={{ tab: "logs" }}
					search={{ workspace: workspace.id, since: "1h" }}
					className="pk-link"
					data-testid="detail-view-logs"
				>
					Logs for this workspace
				</Link>
			</div>
		</section>
	);
}
