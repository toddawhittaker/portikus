import type { CheckRun, Project } from "@portikus/contracts";
import { Button, EmptyState, IconButton, StateBadge, Toggletip } from "@portikus/ui";
import { useState } from "react";
import { CheckOutput } from "./CheckOutput.js";
import { CHECK_BADGE } from "./checkBadge.js";
import "./checks.css";
import { PaneSplit } from "../shell/paneSplit.js";
import { EditChecksDialog } from "./EditChecksDialog.js";
import { useChecks, useRunCheck, useStopCheck } from "./queries.js";

/**
 * The Checks pane (SPEC.md §18.1): the commands `.portikus/checks.json`
 * configures, what each last did, and the output of the one selected, in a
 * read-only panel. The student can always see the real command.
 */
export function ChecksPane({
	workspaceId,
	project,
}: {
	workspaceId: string;
	project: Project;
}) {
	const projectId = project.id;
	const checks = useChecks(workspaceId, projectId);
	const run = useRunCheck(workspaceId, projectId);
	const stop = useStopCheck(workspaceId, projectId);
	const [selected, setSelected] = useState<string | null>(null);
	const [editing, setEditing] = useState(false);
	// Bumped on every start, so the output panel reconnects for a new run.
	const [runKey, setRunKey] = useState("0");

	const definitions = checks.data?.checks ?? [];
	const runs = new Map<string, CheckRun>(
		(checks.data?.runs ?? []).map((item) => [item.checkId, item]),
	);
	const shown = selected ?? definitions[0]?.id ?? null;
	const shownCheck = definitions.find((check) => check.id === shown);
	// A check with no run has no output to connect to. One that just started
	// counts as run while the list catches up.
	const hasRun =
		shown !== null && (runs.has(shown) || (run.variables === shown && run.isSuccess));

	function start(checkId: string) {
		setSelected(checkId);
		run.mutate(checkId, {
			onSuccess: (started) => setRunKey(started.id),
		});
	}

	const output =
		shown === null ? null : (
			<section className="pk-check-panel" aria-labelledby="check-output-title">
				<h3 className="pk-check-panel-head" id="check-output-title">
					Output{" "}
					{shownCheck ? (
						<span className="pk-check-panel-name" data-testid="check-output-name">
							{shownCheck.name}
						</span>
					) : null}
				</h3>
				{hasRun ? (
					<CheckOutput
						key={`${shown}:${runKey}`}
						workspaceId={workspaceId}
						projectId={projectId}
						checkId={shown}
						name={shownCheck?.name ?? ""}
						onFinished={() => void checks.refetch()}
					/>
				) : (
					<p className="pk-check-empty" data-testid="check-output-empty">
						Run a check to see its output here.
					</p>
				)}
			</section>
		);

	return (
		<>
			<div className="pk-pane-head pk-pane-head--actions">
				<h2 className="sr-only">Checks</h2>
				<span className="pk-pane-head-about">
					<Toggletip label="Checks">
						Checks are commands your project defines in .portikus/checks.json, such as
						tests or a linter. Run shows their real output here.
					</Toggletip>
				</span>
				<IconButton
					icon="more"
					label="Edit checks"
					size="sm"
					data-testid="checks-edit"
					onClick={() => setEditing(true)}
				/>
			</div>

			{definitions.length === 0 ? (
				<div className="pk-pane-body">
					{checks.data?.error && (
						<p className="pk-hint" data-testid="checks-file-error">
							{checks.data.error}
						</p>
					)}
					<EmptyState
						icon="check"
						title="No checks configured"
						actions={
							<Button
								variant="secondary"
								data-testid="checks-empty-edit"
								onClick={() => setEditing(true)}
							>
								Edit checks…
							</Button>
						}
					>
						Add a command such as <code>npm test</code> and run it here.
					</EmptyState>
				</div>
			) : (
				<PaneSplit storageKey="pk-checks-output" label="Resize output" panel={output}>
					<div className="pk-pane-body">
						{checks.data?.error && (
							<p className="pk-hint" data-testid="checks-file-error">
								{checks.data.error}
							</p>
						)}
						<ul className="pk-list pk-check-list" data-testid="checks-list">
							{definitions.map((check) => {
								const state = runs.get(check.id)?.state ?? "idle";
								const badge = CHECK_BADGE[state];
								const running = state === "running";
								return (
									<li
										key={check.id}
										className={`pk-check-item${shown === check.id ? " is-current" : ""}`}
										data-testid={`check-item-${check.id}`}
									>
										<div className="pk-check-row">
											<button
												type="button"
												className="pk-check-face"
												aria-current={shown === check.id ? "true" : undefined}
												onClick={() => setSelected(check.id)}
											>
												<span className="pk-check-text">
													<span className="pk-check-name" title={check.name}>
														{check.name}
													</span>
													<span className="pk-check-command" title={check.command}>
														{check.command}
													</span>
												</span>
											</button>
											<span
												className="pk-check-badge"
												data-testid={`check-state-${check.id}`}
											>
												<StateBadge state={badge.state} label={badge.label} />
											</span>
											<IconButton
												icon={running ? "stop" : "play"}
												label={`${running ? "Stop" : "Run"} ${check.name}`}
												size="sm"
												className={running ? "pk-iconbtn-danger" : "pk-check-run"}
												data-testid={`check-${running ? "stop" : "run"}-${check.id}`}
												onClick={() =>
													running ? stop.mutate(check.id) : start(check.id)
												}
											/>
										</div>
									</li>
								);
							})}
						</ul>
					</div>
				</PaneSplit>
			)}

			{editing && (
				<EditChecksDialog
					workspaceId={workspaceId}
					projectId={projectId}
					checks={definitions}
					onClose={() => setEditing(false)}
				/>
			)}
		</>
	);
}
