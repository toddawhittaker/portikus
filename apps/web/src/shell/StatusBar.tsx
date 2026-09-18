import type { Project, Workspace } from "@portikus/contracts";
import { resolveWorkspaceState, ShortcutHint } from "@portikus/ui";
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

/** The bottom bar: where you are, how the workspace is, and how to leave a terminal. */
export function StatusBar({
	workspaceId,
	project,
	workspace,
}: {
	workspaceId: string;
	project: Project | undefined;
	workspace: Workspace | null;
}) {
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
			<span className="pk-statusbar-item" data-testid="workspace-state">
				<span
					className={`pk-dot ${TONE_CLASS[resolved.tone] ?? "pk-tone-stopped"}`}
					aria-hidden="true"
				/>
				{resolved.label}
			</span>
			<span className="pk-statusbar-item">
				Leave terminal <ShortcutHint keys={["Alt", "Shift", "Q"]} />
			</span>
		</footer>
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
