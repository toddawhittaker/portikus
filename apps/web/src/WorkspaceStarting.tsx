import type { Workspace } from "@portikus/contracts";
import { useEffect, useState } from "react";

const STATE_TEXT: Record<string, string> = {
	creating: "Creating your workspace…",
	starting: "Starting your workspace…",
	stopping: "Stopping your workspace…",
	stopped: "Your workspace is stopped. Starting it now…",
	error: "Your workspace could not be started.",
};

function remaining(deadline: string, now: number): string {
	const seconds = Math.max(0, Math.round((Date.parse(deadline) - now) / 1000));
	const minutes = Math.floor(seconds / 60);
	const rest = String(seconds % 60).padStart(2, "0");
	return `${minutes}:${rest}`;
}

/**
 * The connecting/starting state (SPEC.md §6.3) and, during the disconnect
 * grace period, how long is left before the workspace stops (SPEC.md §6.4).
 */
export function WorkspaceStarting({ workspace }: { workspace: Workspace | null }) {
	const [now, setNow] = useState(() => Date.now());
	const deadline = workspace?.shutdownDeadline ?? null;

	useEffect(() => {
		if (!deadline) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [deadline]);

	return (
		<section className="pk-workspace-starting">
			<h2>Workspace</h2>
			<p data-testid="workspace-state">
				{workspace
					? (STATE_TEXT[workspace.state] ?? `state: ${workspace.state}`)
					: "Connecting…"}
			</p>
			{workspace?.errorMessage && <p role="alert">{workspace.errorMessage}</p>}
			{deadline && (
				<p data-testid="shutdown-countdown">
					Your workspace will stop in {remaining(deadline, now)}. Your files are saved;
					running terminals and previews will end.
				</p>
			)}
		</section>
	);
}
