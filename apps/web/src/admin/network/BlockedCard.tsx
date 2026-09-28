import {
	type AdminEgressView,
	explainHost,
	isEgressHostName,
} from "@portikus/contracts";
import { Button, Toggletip } from "@portikus/ui";

/**
 * The names workspaces were refused most in the last 7 days, counted for the
 * whole site and never tied to a student (SPEC.md section 20.1).
 */
export function BlockedCard({
	view,
	onAllow,
}: {
	view: AdminEgressView;
	onAllow: (host: string) => void;
}) {
	return (
		<section className="pk-card p-6" aria-labelledby="egress-blocked-title">
			<div className="flex items-center gap-1">
				<h3 className="pk-text-heading m-0" id="egress-blocked-title" tabIndex={-1}>
					Refused names
				</h3>
				<Toggletip label="refused names">
					In allow-list mode, a name here often means a course tool needs allowing. In
					open mode, only your blocked sites are refused.
				</Toggletip>
			</div>
			<p className="pk-text-body pk-muted mt-1 mb-0">
				The sites workspaces were refused most in the last 7 days, for the whole site.
				They are never tied to a student.
			</p>
			{view.blocked.length === 0 ? (
				<p
					className="m-0 mt-3 text-[13px] text-ink-muted"
					data-testid="egress-blocked-empty"
				>
					{view.mode === "open" && view.blockedSites.length === 0
						? "Open mode is on and nothing is blocked, so no site is refused."
						: "No workspace was refused a site in the last 7 days."}
				</p>
			) : (
				<div className="pk-table-wrap mt-4">
					<table className="pk-table" data-testid="egress-blocked">
						<caption className="sr-only">Refused names, last 7 days</caption>
						<thead>
							<tr>
								<th scope="col">Name</th>
								<th scope="col" className="text-right">
									Refusals
								</th>
								<th scope="col">
									<span className="sr-only">Actions</span>
								</th>
							</tr>
						</thead>
						<tbody>
							{view.blocked.map((row) => {
								// Judged as allow-list mode, where the list is used, so open mode still offers "Allow…".
								const listed = explainHost(
									{ ...view, mode: "allow-list" },
									row.name,
								).allowed;
								// In open mode a blocked site is refused on purpose; allowing it would change nothing.
								const blockedSite =
									view.mode === "open" &&
									explainHost(view, row.name).reason === "blocked";
								return (
									<tr key={row.name} data-testid="egress-blocked-row">
										<td className="font-mono [overflow-wrap:anywhere]">{row.name}</td>
										<td className="pk-num text-right">
											{row.count.toLocaleString("en")}
										</td>
										<td className="text-right whitespace-nowrap">
											{!isEgressHostName(row.name) ? null : blockedSite ? (
												<span className="text-[12px] text-ink-muted">Blocked site</span>
											) : listed ? (
												<span className="text-[12px] text-ink-muted">Listed now</span>
											) : (
												<Button
													size="sm"
													aria-label={`Allow ${row.name}…`}
													onClick={() => onAllow(row.name)}
												>
													Allow…
												</Button>
											)}
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			)}
		</section>
	);
}
