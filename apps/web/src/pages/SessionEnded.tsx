import { StandalonePage } from "./StandalonePage.js";

/** Where a 401, or a 4401 close on the workspace socket, lands (SPEC.md §5.3). */
export function SessionEnded() {
	return (
		<StandalonePage testId="page-session-ended">
			<div className="flex flex-col gap-2">
				<h1 id="page-title" className="pk-text-display">
					Your session ended
				</h1>
				<p className="pk-text-body">
					You were signed out, either after a long period without activity or from
					another window.
				</p>
				<p className="pk-text-body pk-muted">
					Your projects are saved in your workspace. Sign in again to pick up where you
					left off.
				</p>
			</div>
			<div className="pk-actions">
				<a
					data-testid="signin"
					href="/auth/login"
					className="pk-btn pk-focus-ring inline-flex h-[var(--size-control-lg)] items-center justify-center rounded-sm bg-surface-inverse px-5 font-medium text-[15px] text-ink-inverse no-underline hover:bg-surface-inverse-hover"
				>
					Sign in again
				</a>
			</div>
		</StandalonePage>
	);
}
