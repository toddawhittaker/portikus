/**
 * The shared project's checks and what each last did (SPEC.md §18.1). Only
 * the results: an instructor cannot run, stop or edit a student's checks.
 */
import type { ChecksResponse } from "@portikus/contracts";
import { StateBadge } from "@portikus/ui";
import { CHECK_BADGE } from "../../checks/checkBadge.js";
import "../../checks/checks.css";

/** "23 Sep 2026, 14:05" in the browser's own locale and zone. */
function timeText(iso: string): string | null {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return null;
	return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function SharedChecks({
	checks,
	error,
}: {
	checks: ChecksResponse | undefined;
	error: boolean;
}) {
	if (!checks) {
		return (
			<p className="pk-changes-empty">
				{error ? "Could not read the checks." : "Loading…"}
			</p>
		);
	}
	const runs = new Map(checks.runs.map((run) => [run.checkId, run]));
	return (
		<>
			{checks.error ? <p className="pk-hint">{checks.error}</p> : null}
			{checks.checks.length === 0 ? (
				<p className="pk-changes-empty" data-testid="shared-checks-empty">
					No checks configured.
				</p>
			) : (
				<ul className="pk-check-list" data-testid="shared-checks">
					{checks.checks.map((check) => {
						const run = runs.get(check.id);
						const badge = CHECK_BADGE[run?.state ?? "idle"];
						const when = run ? timeText(run.endedAt ?? run.startedAt) : null;
						return (
							<li
								key={check.id}
								className="pk-check-item"
								data-testid={`shared-check-${check.id}`}
							>
								<div className="pk-check-row">
									<span className="pk-check-text">
										<span className="pk-check-name">{check.name}</span>
										<span className="pk-check-command">{check.command}</span>
										{when ? (
											<span className="pk-check-command">
												{run?.endedAt ? "Finished" : "Started"} {when}
											</span>
										) : null}
									</span>
									<span
										className="pk-check-badge"
										data-testid={`shared-check-state-${check.id}`}
									>
										<StateBadge state={badge.state} label={badge.label} />
									</span>
								</div>
							</li>
						);
					})}
				</ul>
			)}
		</>
	);
}
