import type { Workspace } from "@portikus/contracts";
import { Button, Icon, Skeleton, useToast } from "@portikus/ui";
import { useWorkspaceAction } from "./api/workspace.js";

export type StartingPhase =
	| "connecting"
	| "starting"
	| "restoring"
	| "stopping"
	| "stopped"
	| "error";

const STEPS = ["connecting", "starting", "restoring"] as const;
const STEP_LABEL = [
	"Connecting to Portikus",
	"Starting your workspace",
	"Reopening your tabs",
];

const COPY: Record<StartingPhase, [string, string]> = {
	connecting: [
		"Connecting to your workspace",
		"Checking where your workspace is. This takes a second or two.",
	],
	starting: [
		"Starting your workspace",
		"This usually takes a few seconds. Your files are already saved on your workspace storage.",
	],
	restoring: [
		"Reopening your tabs",
		"Your workspace is running. Terminals from your last session will show as ended; nothing is rerun.",
	],
	stopping: [
		"Stopping your workspace",
		"Your files are saved. The workspace will start again when you come back.",
	],
	stopped: [
		"Your workspace is stopped",
		"Nothing is running. Your files are saved on your workspace storage; start the workspace again when you are ready.",
	],
	error: [
		"Your workspace could not be started",
		"Portikus could not start the machine behind this window. Nothing you did caused this.",
	],
};

/** Which part of the wait the person is in (design/mockups/WorkspaceStarting). */
export function startingPhase(workspace: Workspace | null): StartingPhase {
	if (!workspace) return "connecting";
	if (workspace.state === "error") return "error";
	if (workspace.state === "stopping") return "stopping";
	// Stopped and not asked to run again: nothing is happening, so do not
	// show a progress spinner that would never finish (SPEC.md §6.3).
	if (workspace.state === "stopped" && workspace.desiredState === "stopped")
		return "stopped";
	if (workspace.state === "running") return "restoring";
	return "starting";
}

/**
 * The center of the shell while the workspace is not running yet
 * (SPEC.md §6.3): what is happening, in order, and nothing to click.
 */
export function WorkspaceStarting({
	workspaceId,
	workspace,
}: {
	workspaceId: string;
	workspace: Workspace | null;
}) {
	const phase = startingPhase(workspace);
	const [heading, sub] = COPY[phase];
	const at = STEPS.indexOf(phase as (typeof STEPS)[number]);

	return (
		<>
			<div className="pk-tabs-skeleton" aria-hidden="true">
				<Skeleton variant="block" width="140px" height="14px" />
				<Skeleton variant="block" width="96px" height="14px" />
			</div>
			<div className="flex flex-1 items-center justify-center p-10">
				<section
					className="pk-card pk-progress-card"
					aria-live="polite"
					aria-labelledby="progress-title"
					data-testid="workspace-progress"
					data-phase={phase}
				>
					<div className="flex flex-col gap-2">
						<h1 id="progress-title" className="pk-text-title">
							{heading}
						</h1>
						<p className="pk-text-body pk-muted">{sub}</p>
					</div>
					{at >= 0 && (
						<ol className="pk-steps">
							{STEP_LABEL.map((label, index) => {
								const state = index < at ? "done" : index === at ? "active" : "pending";
								return (
									<li
										key={label}
										className={`pk-step pk-step--${state}`}
										aria-current={index === at ? "step" : undefined}
									>
										<span className="pk-step-glyph">
											{state === "done" && <Icon name="check" size="md" />}
											{state === "active" && (
												<span className="pk-spin" aria-hidden="true" />
											)}
											{state === "pending" && (
												<span className="pk-step-ring" aria-hidden="true" />
											)}
										</span>
										<span>{label}</span>
									</li>
								);
							})}
						</ol>
					)}
					{phase === "stopped" && <StartAgain workspaceId={workspaceId} />}
					{phase === "error" && workspace?.errorMessage && (
						<>
							<hr className="pk-divider" />
							<div className="flex flex-col gap-3">
								<p className="pk-text-body">{workspace.errorMessage}</p>
								{workspace.errorCode && (
									<p className="pk-techdetail">{workspace.errorCode}</p>
								)}
							</div>
						</>
					)}
				</section>
			</div>
		</>
	);
}

/**
 * The way back from a workspace the student stopped by hand. It asks for the
 * same desired-state change as the Start button in the workspace dialog, and
 * the presence socket reports the workspace running (SPEC.md §6.2, §6.3).
 */
function StartAgain({ workspaceId }: { workspaceId: string }) {
	const action = useWorkspaceAction(workspaceId);
	const toast = useToast();

	return (
		<div className="flex">
			<Button
				variant="primary"
				disabled={action.isPending}
				data-testid="workspace-resume"
				onClick={() =>
					action.mutate("start", {
						onError: (error) =>
							toast.show({
								tone: "danger",
								title: "The workspace did not start",
								children: error instanceof Error ? error.message : undefined,
							}),
					})
				}
			>
				Start workspace
			</Button>
		</div>
	);
}
