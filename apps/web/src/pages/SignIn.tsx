import { Navigate } from "@tanstack/react-router";
import { useEnsureWorkspace } from "../api/workspace.js";
import { gatePath, useMe } from "../useMe.js";
import { StandalonePage } from "./StandalonePage.js";

/**
 * The front door (design/mockups/Main). A signed-in student never sees it:
 * a student goes straight to their workspace and an administrator to /admin.
 */
export function SignIn() {
	const me = useMe();
	// An administrator gets a workspace only by opening one (SPEC.md §6.1).
	const isAdmin = me.status === "authenticated" && me.user.role === "administrator";
	// The root route sends a gated account to its gate's page (SPEC.md section 5.3).
	const mustChange = gatePath(me) !== null;
	const workspace = useEnsureWorkspace(
		me.status === "authenticated" && !isAdmin && !mustChange,
	);

	if (me.status === "loading" || mustChange)
		return <div className="pk-root" aria-busy="true" />;
	if (me.status === "forbidden") return <Navigate to="/not-authorized" />;
	if (isAdmin) return <Navigate to="/admin" replace />;
	if (me.status === "authenticated") {
		if (workspace.data) {
			return (
				<Navigate to="/workspaces/$id" params={{ id: workspace.data.id }} replace />
			);
		}
		return <div className="pk-root" aria-busy="true" />;
	}

	return (
		<StandalonePage title="Sign in" testId="page-signin">
			<div className="flex flex-col gap-2">
				<h1 id="page-title" className="pk-text-display">
					Sign in to Portikus
				</h1>
				<p className="pk-text-body pk-muted">
					A Linux workspace with a shell, Git, Docker, Claude Code and Codex, in your
					browser. Nothing to install.
				</p>
			</div>
			<div className="flex flex-col gap-3">
				{/* A real navigation, so the session cookie is set on the way back. */}
				<a
					data-testid="signin"
					href="/auth/login"
					className="pk-btn pk-focus-ring inline-flex h-[var(--size-control-lg)] w-full items-center justify-center rounded-sm bg-surface-inverse px-5 font-medium text-[15px] text-ink-inverse no-underline hover:bg-surface-inverse-hover"
				>
					Continue to institution sign-in
				</a>
				<p className="pk-text-caption pk-muted">
					You'll go to your institution's sign-in page and come back here.
				</p>
			</div>
			<hr className="pk-divider" />
			<p className="pk-text-compact pk-muted">
				There is no sign-up. Access comes from your institution account; if you expect
				access and don't have it, ask your instructor.
			</p>
		</StandalonePage>
	);
}
