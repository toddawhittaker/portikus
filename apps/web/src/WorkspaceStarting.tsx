import type { PendingOperation, Workspace, WorkspaceUsage } from "@portikus/contracts";
import { Button, Icon, Skeleton, useToast } from "@portikus/ui";
import { useEffect, useRef, useState } from "react";
import { useWorkspaceAction } from "./api/workspace.js";
import { DialogError } from "./common/DialogError.js";
import { formatBytes } from "./monitor/format.js";
import { STORAGE_POLL_MS, useWorkspaceUsage } from "./monitor/usage.js";
import { useResetDocker } from "./recovery/queries.js";
import {
	STORAGE_CLASSES,
	type StorageClass,
	storageLevel,
} from "./recovery/storage.js";
import { StorageMeters } from "./shell/StorageMeters.js";
import { ResetDocker, TechnicalSummary } from "./shell/WorkspaceDialog.js";

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

/** A new workspace waiting for room in the storage pool (SPEC.md §20.1). */
const POOL_FULL_COPY: [string, string] = [
	"Waiting for room for your workspace",
	"Portikus will create it as soon as there is room. You can leave this page open or come back later.",
];

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
	"replace-home": [
		"Replacing your home folder…",
		"An administrator is replacing your home folder with one from a backup. Your projects get recovery points first, and your current home folder is kept. This can take several minutes.",
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
 * Errors only an administrator can fix (SPEC.md §28). STORAGE_FULL is not one:
 * an administrator may have grown the quota since, so a retry can succeed.
 */
const NOT_RETRYABLE = new Set(["IMAGE_NOT_FOUND", "INSTANCE_MISSING"]);

/** Whether Try again can help. */
export function canRetry(errorCode: string | null | undefined): boolean {
	return !errorCode || !NOT_RETRYABLE.has(errorCode);
}

const USING: Record<StorageClass, string> = {
	home: "Your projects and home folder are using",
	docker: "Docker is using",
	recovery: "Recovery points are using",
};

/**
 * The storage-full sentence: which storage filled up, with its figures, and
 * the next step (SPEC.md §28). Docker comes first because a reset frees it.
 */
export function storageFullText(
	storage: WorkspaceUsage["storage"] | undefined,
): string {
	const full: StorageClass | undefined = offerDockerCleanup("STORAGE_FULL", storage)
		? "docker"
		: STORAGE_CLASSES.find(
				(storageClass) => storageLevel(storage?.[storageClass] ?? null) === "critical",
			);
	const figure = full ? storage?.[full] : null;
	if (!full || !figure)
		return "Its storage is full. Ask your administrator for more space. Your files are kept.";
	const using = `${USING[full]} ${formatBytes(figure.usedBytes)} of ${formatBytes(figure.totalBytes)}.`;
	return full === "docker"
		? `Its storage is full. ${using} Reset Docker to free that space; your projects and home folder are kept.`
		: `Its storage is full. ${using} Ask your administrator for more space. Your files are kept.`;
}

/** The sentence under the heading for an error that is not about storage. */
function errorText(errorCode: string | null | undefined): string {
	return canRetry(errorCode)
		? COPY.error[1]
		: "Portikus could not start the machine behind this window. Nothing you did caused this. Ask your administrator for help.";
}

/** Why a workspace stopped on its own, after "Still working?" went unanswered. */
function idleStopText(minutes: number | null): string {
	if (minutes === null) return "Stopped because nothing happened in it for a while.";
	return `Stopped after ${minutes} ${minutes === 1 ? "minute" : "minutes"} without activity.`;
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
	const waitingForRoom =
		workspace?.state === "provisioning" && workspace.errorCode === "POOL_FULL";
	const [heading, sub] = pending
		? PENDING_COPY[pending]
		: waitingForRoom
			? POOL_FULL_COPY
			: COPY[phase];
	// No spinner while waiting for room: nothing is starting yet.
	const at = waitingForRoom ? -1 : STEPS.indexOf(phase as (typeof STEPS)[number]);
	// The agent may still answer while the workspace is in error (SPEC.md §18.3).
	const usage = useWorkspaceUsage(
		workspaceId,
		phase === "error",
		STORAGE_POLL_MS,
		true,
	);
	const storage = phase === "error" ? usage.data?.storage : undefined;
	const reset = useResetDocker(workspaceId);
	const [cleaning, setCleaning] = useState(false);
	const headingRef = useRef<HTMLHeadingElement>(null);
	const cardRef = useRef<HTMLElement>(null);
	const lastFocused = useRef<Element | null>(null);
	// A focused button that vanishes with the phase drops focus to the body; catch it there.
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs on phase change only
	useEffect(() => {
		const gone = lastFocused.current && !lastFocused.current.isConnected;
		const active = document.activeElement;
		if (gone && (active === null || active === document.body)) {
			lastFocused.current = null;
			headingRef.current?.focus();
		}
	}, [phase, pending]);
	const errorCode = workspace?.errorCode;
	const storageFull = phase === "error" && errorCode === "STORAGE_FULL";
	const cleanDocker = phase === "error" && offerDockerCleanup(errorCode, storage);

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
					ref={cardRef}
					className="pk-card pk-progress-card"
					onFocus={(event) => {
						lastFocused.current = event.target;
					}}
					onBlur={(event) => {
						// A removed button blurs with no target; keep it so the effect can see it went.
						if (event.relatedTarget && !cardRef.current?.contains(event.relatedTarget))
							lastFocused.current = null;
					}}
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
									{pending || phase !== "error"
										? sub
										: storageFull
											? storageFullText(storage)
											: errorText(errorCode)}
								</p>
							</div>
							{workspace?.state === "provisioning" && workspace.errorMessage && (
								// A new workspace waiting for room in the storage pool (SPEC.md §20.1).
								<p className="pk-text-body" data-testid="workspace-waiting">
									{workspace.errorMessage}
								</p>
							)}
							{idleStop && (phase === "stopping" || phase === "stopped") && (
								<p className="pk-text-body" data-testid="idle-stopped">
									{idleStopText(idleStop.minutes)}
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
								{cleanDocker && (
									<ResetDocker
										workspace={workspace}
										primary
										testId="workspace-clean-docker"
										confirming={cleaning}
										setConfirming={setCleaning}
										reset={reset}
									/>
								)}
								{canRetry(errorCode) && (
									<StartButton
										workspaceId={workspaceId}
										testId="workspace-retry"
										primary={!cleanDocker}
									>
										Try again
									</StartButton>
								)}
								<Button
									aria-haspopup="dialog"
									data-testid="workspace-details"
									onClick={onOpenWorkspace}
								>
									Workspace details
								</Button>
							</div>
							<DialogError error={reset.error} />
							{(workspace?.errorMessage || workspace?.errorCode) && (
								<details className="group" data-testid="workspace-error-details">
									<TechnicalSummary />
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
	primary = true,
	children,
}: {
	workspaceId: string;
	testId: string;
	primary?: boolean;
	children: string;
}) {
	const action = useWorkspaceAction(workspaceId);
	const toast = useToast();

	return (
		<Button
			variant={primary ? "primary" : "secondary"}
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
