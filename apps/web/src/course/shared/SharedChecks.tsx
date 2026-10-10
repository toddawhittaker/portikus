/**
 * The shared project's checks and what each last did (SPEC.md §18.1). Only
 * names and results: an instructor cannot run, stop or edit a student's
 * checks, and never sees their commands (SPEC.md §5.2).
 */
import type { SharedChecksResponse } from "@portikus/contracts";
import { StateBadge } from "@portikus/ui";
import { CHECK_BADGE } from "../../checks/checkBadge.js";
import { dateTimeText } from "../time.js";
import "../../checks/checks.css";

export function SharedChecks({
	checks,
	error,
}: {
	checks: SharedChecksResponse | undefined;
	error: boolean;
}) {
	if (!checks) {
		return (
			<p className="pk-changes-empty">
				{error ? "Could not read the checks." : "Loading…"}
			</p>
		);
	}
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
						const run = check.lastRun;
						const badge = CHECK_BADGE[run?.state ?? "idle"];
						return (
							<li
								key={check.id}
								className="pk-check-item"
								data-testid={`shared-check-${check.id}`}
							>
								<div className="pk-check-row">
									<span className="pk-check-text">
										<span className="pk-check-name">{check.name}</span>
										{run ? (
											<span className="pk-check-command">
												{run.endedAt ? "Finished" : "Started"}{" "}
												{dateTimeText(run.endedAt ?? run.startedAt)}
											</span>
										) : null}
									</span>
									<span
										className="pk-check-badge"
										data-testid={`shared-check-state-${check.id}`}
									>
										{/* Not a live region: every poll would announce every badge. */}
										<StateBadge
											state={badge.state}
											label={badge.label}
											statusRole={false}
										/>
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
