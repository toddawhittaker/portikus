import type { Project, Workspace } from "@portikus/contracts";
import {
	Button,
	ConfirmDialog,
	ConfirmDialogRoot,
	Dialog,
	DialogRoot,
	resolveWorkspaceState,
	useToast,
} from "@portikus/ui";
import { useState } from "react";
import { useWorkspaceAction } from "../api/workspace.js";
import { gitBar } from "../files/gitStatus.js";
import { useGitStatus } from "../files/useGitStatus.js";
import { useCountdown } from "./useCountdown.js";

const TONE_CLASS: Record<string, string> = {
	running: "pk-tone-running",
	starting: "pk-tone-starting",
	provisioning: "pk-tone-starting",
	stopping: "pk-tone-starting",
	stopped: "pk-tone-stopped",
	error: "pk-tone-error",
};

/** Image fingerprints are 64 characters; a student only ever needs the head of one. */
function shortImage(imageVersion: string | null): string {
	if (!imageVersion) return "—";
	return imageVersion.length > 12 ? `${imageVersion.slice(0, 12)}…` : imageVersion;
}

/** The bottom bar: where you are, and the workspace state, which opens its dialog. */
export function StatusBar({
	workspaceId,
	project,
	workspace,
}: {
	workspaceId: string;
	project: Project | undefined;
	workspace: Workspace | null;
}) {
	const [statusOpen, setStatusOpen] = useState(false);
	const resolved = workspace
		? resolveWorkspaceState(workspace.state, workspace.desiredState)
		: { tone: "starting" as const, label: "Connecting" };
	const countdown = useCountdown(workspace?.shutdownDeadline ?? null);

	return (
		<footer className="pk-statusbar" data-testid="status-bar">
			<span className="pk-statusbar-item pk-statusbar-mono">
				{project ? `~/projects/${project.slug}` : "~/projects"}
			</span>
			{project && !project.missing ? (
				<GitSegment workspaceId={workspaceId} projectId={project.id} />
			) : null}
			<span className="pk-statusbar-spacer" />
			{countdown && (
				<span className="pk-statusbar-item pk-tone-warning">
					Stopping in {countdown.clock}
				</span>
			)}
			<button
				type="button"
				className="pk-statusbar-item"
				aria-haspopup="dialog"
				data-testid="workspace-status"
				onClick={() => setStatusOpen(true)}
			>
				<span
					className={`pk-dot ${TONE_CLASS[resolved.tone] ?? "pk-tone-stopped"}`}
					aria-hidden="true"
				/>
				<span data-testid="workspace-state" role="status">
					{resolved.label}
				</span>
			</button>

			<DialogRoot open={statusOpen} onOpenChange={setStatusOpen}>
				{statusOpen && (
					<Dialog
						testId="dialog-workspace-status"
						title="Your workspace"
						description="What Portikus knows about the machine behind this window."
						onClose={() => setStatusOpen(false)}
					>
						<dl className="grid min-w-0 grid-cols-[max-content_minmax(0,1fr)] gap-x-6 gap-y-1 text-[13px]">
							<dt className="text-ink-muted">State</dt>
							<dd className="m-0" data-testid="workspace-status-state">
								{workspace?.state ?? "connecting"}
							</dd>
							<dt className="text-ink-muted">Desired state</dt>
							<dd className="m-0">{workspace?.desiredState ?? "running"}</dd>
							<dt className="text-ink-muted">Connections</dt>
							<dd className="m-0">{workspace?.activeConnections ?? 0}</dd>
							<dt className="text-ink-muted">Image</dt>
							<dd
								className="m-0 min-w-0 pk-mono-small"
								data-testid="workspace-status-image"
								title={workspace?.imageVersion ?? undefined}
							>
								{shortImage(workspace?.imageVersion ?? null)}
							</dd>
						</dl>
						{workspace?.errorMessage ? (
							<p className="pk-text-body mt-4 text-status-error">
								{workspace.errorMessage}
							</p>
						) : null}
						<WorkspaceControls workspaceId={workspaceId} workspace={workspace} />
					</Dialog>
				)}
			</DialogRoot>
		</footer>
	);
}

/**
 * Start, stop and restart from the workspace dialog (SPEC.md §6.2). These
 * only ask the API to change the desired state, so they still work when the
 * workspace itself is hung, which is how a student recovers one.
 */
function WorkspaceControls({
	workspaceId,
	workspace,
}: {
	workspaceId: string;
	workspace: Workspace | null;
}) {
	const action = useWorkspaceAction(workspaceId);
	const toast = useToast();
	const [confirming, setConfirming] = useState<"stop" | "restart" | null>(null);

	const resolved = workspace
		? resolveWorkspaceState(workspace.state, workspace.desiredState)
		: null;
	// No workspace yet means the presence socket has not reported one.
	const moving = resolved === null || resolved.moving || action.isPending;
	const stopped = workspace?.state === "stopped" || workspace?.state === "error";

	function run(next: "start" | "stop" | "restart") {
		setConfirming(null);
		action.mutate(next, {
			onError: (error) =>
				toast.show({
					tone: "danger",
					title: "The workspace did not change",
					children: error instanceof Error ? error.message : undefined,
				}),
		});
	}

	return (
		<div className="mt-5 flex flex-wrap items-center gap-2">
			{stopped ? (
				<Button
					variant="primary"
					disabled={moving}
					data-testid="workspace-start"
					onClick={() => run("start")}
				>
					Start workspace
				</Button>
			) : (
				<>
					<Button
						disabled={moving}
						data-testid="workspace-restart"
						onClick={() => setConfirming("restart")}
					>
						Restart workspace
					</Button>
					<Button
						disabled={moving}
						data-testid="workspace-stop"
						onClick={() => setConfirming("stop")}
					>
						Stop workspace
					</Button>
				</>
			)}
			{resolved?.moving ? (
				<span
					className="pk-text-small text-ink-muted"
					data-testid="workspace-transition"
				>
					{resolved.label} your workspace.
				</span>
			) : null}

			<ConfirmDialogRoot
				open={confirming !== null}
				onOpenChange={(open) => !open && setConfirming(null)}
			>
				{confirming ? (
					<ConfirmDialog
						testId={`dialog-workspace-${confirming}`}
						title={
							confirming === "stop" ? "Stop your workspace?" : "Restart your workspace?"
						}
						description="Programs running in the workspace end. Your files are kept."
						lost={["everything running now, including terminals and servers"]}
						survives={["every file in your home directory"]}
						confirmLabel={
							confirming === "stop" ? "Stop workspace" : "Restart workspace"
						}
						pending={action.isPending}
						onCancel={() => setConfirming(null)}
						onConfirm={() => run(confirming)}
					/>
				) : null}
			</ConfirmDialogRoot>
		</div>
	);
}

/**
 * The compact Git line of SPEC.md §12.8. Conflicts are drawn in the warning
 * tone, because an unresolved merge is not an ordinary change.
 */
function GitSegment({
	workspaceId,
	projectId,
}: {
	workspaceId: string;
	projectId: string;
}) {
	const status = useGitStatus(workspaceId, projectId);
	const bar = gitBar(status.data);
	if (!bar) return null;
	const tone = !bar.repo
		? "pk-statusbar-muted"
		: bar.conflicts > 0
			? "pk-tone-warning"
			: "";
	return (
		<span
			className={`pk-statusbar-item ${tone}`}
			data-testid="git-status"
			data-conflicts={bar.conflicts > 0 ? "true" : undefined}
		>
			{bar.text}
		</span>
	);
}
