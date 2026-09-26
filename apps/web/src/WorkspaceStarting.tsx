import type { PendingOperation, Workspace, WorkspaceUsage } from "@portikus/contracts";
import { Button, Icon, Skeleton, useToast } from "@portikus/ui";
import { useEffect, useRef, useState } from "react";
import { useWorkspaceAction } from "./api/workspace.js";
import { STORAGE_POLL_MS, useWorkspaceUsage } from "./monitor/usage.js";
import { storageLevel } from "./recovery/storage.js";
import { StorageMeters } from "./shell/StorageMeters.js";
import { ResetDocker } from "./shell/WorkspaceDialog.js";

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

/** What the wait is while a maintenance operation runs (SPEC.md §16.4, §17.2, §27). */
const PENDING_COPY: Record<PendingOperation, [string, string]> = {
	"reset-docker": [
		"Resetting Docker…",
		"Docker's storage is being replaced with an empty one. Your projects, home folder and recovery points are kept.",
	],
	rebuild: [
		"Rebuilding…",
		"An administrator is rebuilding the workspace system. Your projects and home folder are kept.",
	],
	"rebuild-reset-docker": [
		"Rebuilding…",
		"An administrator is rebuilding the workspace system and resetting Docker. Your projects and home folder are kept.",
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

/** Whether any storage class reported a figure. */
function hasFigures(storage: WorkspaceUsage["storage"] | undefined): boolean {
	return !!storage && Object.values(storage).some((figure) => figure !== null);
}

/**
 * Offer a Docker reset from the error screen only when Docker is what filled
 * up; resetting it for full project storage would destroy data for nothing.
 */
export function offerDockerCleanup(
	errorCode: string | null | undefined,
	storage: WorkspaceUsage["storage"] | undefined,
): boolean {
	return (
		errorCode === "STORAGE_FULL" && storageLevel(storage?.docker ?? null) === "critical"
	);
}

/**
 * The center of the shell while the workspace is not running yet
 * (SPEC.md §6.3): what is happening, in order.
 */
export function WorkspaceStarting({
	workspaceId,
	workspace,
	idleStop,
	onOpenWorkspace,
}: {
	workspaceId: string;
	workspace: Workspace | null;
	/** Set when this page saw "Still working?" go unanswered (ADR 0032). */
	idleStop?: { minutes: number | null } | undefined;
	/** Opens the "Your workspace" dialog. */
	onOpenWorkspace: () => void;
}) {
	const phase = startingPhase(workspace);
	const pending = workspace?.pendingOperation ?? null;
	const [heading, sub] = pending ? PENDING_COPY[pending] : COPY[phase];
	const at = STEPS.indexOf(phase as (typeof STEPS)[number]);
	// The agent may still answer while the workspace is in error (SPEC.md §18.3).
	const usage = useWorkspaceUsage(workspaceId, phase === "error", STORAGE_POLL_MS);
	const storage = phase === "error" ? usage.data?.storage : undefined;
	const [cleaning, setCleaning] = useState(false);
	const headingRef = useRef<HTMLHeadingElement>(null);
	const firstRender = useRef(true);
	// A button that vanishes with the phase drops focus to the body; catch it there.
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs on phase change only
	useEffect(() => {
		if (firstRender.current) {
			firstRender.current = false;
			return;
		}
		const active = document.activeElement;
		if (active === null || active === document.body) headingRef.current?.focus();
	}, [phase, pending]);
	const storageFull = phase === "error" && workspace?.errorCode === "STORAGE_FULL";

	return (
		<>
			{/* A skeleton says something is loading, so only while it is. */}
			{at >= 0 && (
				<div className="pk-tabs-skeleton" aria-hidden="true">
					<Skeleton variant="block" width="140px" height="14px" />
					<Skeleton variant="block" width="96px" height="14px" />
				</div>
			)}
			<div className="flex flex-1 items-center justify-center p-10">
				<section
					className="pk-card pk-progress-card"
					aria-labelledby="progress-title"
					data-testid="workspace-progress"
					data-phase={phase}
					data-pending={pending ?? undefined}
				>
					<div className="flex items-start gap-3">
						{phase === "error" && (
							<div className="pk-dialog-status bg-status-error-soft text-status-error">
								<Icon name="alert" size="lg" />
							</div>
						)}
						<div className="flex flex-col gap-2">
							<div className="flex flex-col gap-2" aria-live="polite">
								<h1
									id="progress-title"
									ref={headingRef}
									tabIndex={-1}
									className="pk-text-title"
								>
									{heading}
								</h1>
								<p className="pk-text-body pk-muted" data-testid="progress-sub">
									{storageFull && !pending
										? "Portikus could not start the machine behind this window. Your storage is full."
										: sub}
								</p>
							</div>
							{idleStop && (phase === "stopping" || phase === "stopped") && (
								<p className="pk-text-body" data-testid="idle-stopped">
									{idleStop.minutes === null
										? "Stopped because nothing happened in it for a while."
										: `Stopped after ${idleStop.minutes} ${
												idleStop.minutes === 1 ? "minute" : "minutes"
											} without activity.`}
								</p>
							)}
						</div>
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
					{phase === "stopped" && (
						<div className="flex">
							<StartButton workspaceId={workspaceId} testId="workspace-resume">
								Start workspace
							</StartButton>
						</div>
					)}
					{phase === "error" && (
						<>
							{storage && hasFigures(storage) && <StorageMeters storage={storage} />}
							<div className="pk-actions">
								<StartButton workspaceId={workspaceId} testId="workspace-retry">
									Try again
								</StartButton>
								<Button
									aria-haspopup="dialog"
									data-testid="workspace-details"
									onClick={onOpenWorkspace}
								>
									Workspace details
								</Button>
								{offerDockerCleanup(workspace?.errorCode, storage) && (
									<ResetDocker
										workspaceId={workspaceId}
										workspace={workspace}
										label="Clean up Docker…"
										testId="workspace-clean-docker"
										confirming={cleaning}
										setConfirming={setCleaning}
									/>
								)}
							</div>
							{(workspace?.errorMessage || workspace?.errorCode) && (
								<details data-testid="workspace-error-details">
									<summary className="pk-text-body pk-summary">
										Technical details
									</summary>
									<div className="pk-techdetail mt-2 flex flex-col gap-1">
										{workspace.errorMessage && (
											<p className="m-0">{workspace.errorMessage}</p>
										)}
										{workspace.errorCode && (
											<p className="m-0">{workspace.errorCode}</p>
										)}
									</div>
								</details>
							)}
						</>
					)}
				</section>
			</div>
		</>
	);
}

/**
 * The way back from a stopped or failed workspace. It asks for the same
 * desired-state change as the Start button in the workspace dialog, and the
 * presence socket reports the workspace running (SPEC.md §6.2, §6.3).
 */
function StartButton({
	workspaceId,
	testId,
	children,
}: {
	workspaceId: string;
	testId: string;
	children: string;
}) {
	const action = useWorkspaceAction(workspaceId);
	const toast = useToast();

	return (
		<Button
			variant="primary"
			disabled={action.isPending}
			data-testid={testId}
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
			{children}
		</Button>
	);
}
