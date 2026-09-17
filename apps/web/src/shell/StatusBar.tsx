import type { Project, Workspace } from "@portikus/contracts";
import { resolveWorkspaceState, ShortcutHint } from "@portikus/ui";
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
	project,
	workspace,
}: {
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
