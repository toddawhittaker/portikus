import { Link } from "@tanstack/react-router";
import { useMe } from "./useMe";
import { useWorkspaceSocket } from "./useWorkspaceSocket";
import { WorkspaceStarting } from "./WorkspaceStarting";

/**
 * The workspace screen. The three-pane shell and the project routes that
 * mount the work area are built alongside this by the shell task; this page
 * keeps the starting state until they land.
 */
export function WorkspacePage() {
	const { me, signedOut } = useMe();
	const workspace = useWorkspaceSocket(me.status === "authenticated", signedOut);
	const running = workspace?.state === "running";

	if (me.status === "loading") return <main>Loading…</main>;
	if (me.status === "anonymous") {
		return (
			<main>
				<p>
					<a href="/auth/login">Sign in</a>
				</p>
			</main>
		);
	}

	return (
		<main className="pk-workspace">
			<p>
				<Link to="/">Back to home</Link>
			</p>
			{!running || !workspace ? (
				<WorkspaceStarting workspace={workspace} />
			) : (
				<p>Open a project to start working.</p>
			)}
		</main>
	);
}
