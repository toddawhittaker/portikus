import { StandalonePage } from "./StandalonePage.js";

/** Any address the app does not know, including the removed /setup. */
export function NotFound() {
	return (
		<StandalonePage title="Page not found" testId="page-not-found">
			<div className="flex flex-col gap-2">
				<h1 id="page-title" className="pk-text-display">
					Page not found
				</h1>
				<p className="pk-text-body">There is nothing at this address.</p>
			</div>
			<p className="pk-text-body">
				<a
					href="/"
					className="pk-focus-ring text-[var(--accent-text)] underline underline-offset-2"
				>
					Go to the Portikus home page
				</a>
			</p>
		</StandalonePage>
	);
}
