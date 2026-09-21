import type { CheckRun, CheckState, Project } from "@portikus/contracts";
import { Button, EmptyState, IconButton, StateBadge } from "@portikus/ui";
import { useState } from "react";
import { CheckOutput } from "./CheckOutput.js";
import "./checks.css";
import { EditChecksDialog } from "./EditChecksDialog.js";
import { useChecks, useRunCheck, useStopCheck } from "./queries.js";

/** What a check's badge says, and which colour it borrows (DESIGN.md §6). */
const BADGE: Record<
	CheckState | "idle",
	{ state: "stopped" | "starting" | "running" | "error"; label: string }
> = {
	idle: { state: "stopped", label: "Not run yet" },
	running: { state: "starting", label: "Running" },
	passed: { state: "running", label: "Passed" },
	failed: { state: "error", label: "Failed" },
	error: { state: "error", label: "Could not run" },
};

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

	function start(checkId: string) {
		setSelected(checkId);
		run.mutate(checkId, {
			onSuccess: (started) => setRunKey(started.id),
		});
	}

	return (
		<>
			<div className="pk-pane-head">
				<h2 className="pk-pane-title">Checks</h2>
				<IconButton
					icon="more"
					label="Edit checks"
					size="sm"
					data-testid="checks-edit"
					onClick={() => setEditing(true)}
				/>
			</div>
			<div className="pk-pane-sub">~/projects/{project.slug}</div>

			<div className="pk-pane-body">
				{checks.data?.error && (
					<p className="pk-hint" data-testid="checks-file-error">
						{checks.data.error}
					</p>
				)}
				{definitions.length === 0 ? (
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
				) : (
					<ul className="pk-list pk-check-list" data-testid="checks-list">
						{definitions.map((check) => {
							const state = runs.get(check.id)?.state ?? "idle";
							const badge = BADGE[state];
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
				)}
			</div>

			{shown !== null && (
				<div className="pk-check-panel">
					<div className="pk-check-panel-head">Output</div>
					<CheckOutput
						key={`${shown}:${runKey}`}
						workspaceId={workspaceId}
						projectId={projectId}
						checkId={shown}
						onFinished={() => void checks.refetch()}
					/>
				</div>
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
