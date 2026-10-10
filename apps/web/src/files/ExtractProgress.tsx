/**
 * The bar in the "Extracting…" toast (SPEC.md §11.2). It polls the agent's
 * count of entries written while the toast is up. The toast is a status
 * region, so the ticking figure is kept out of it: the wrapper turns live
 * announcements off and the bar carries the figure for anyone who reads it.
 */
import { useExtractProgress } from "./queries.js";

export function ExtractProgress({
	workspaceId,
	projectId,
}: {
	workspaceId: string;
	projectId: string;
}) {
	const progress = useExtractProgress(workspaceId, projectId);
	const done = progress.data?.done ?? 0;
	const total = progress.data?.total ?? 0;
	// unzip has not counted the entries yet, so the bar has nothing to fill.
	const counted = total > 0;
	const figure = counted
		? `${Math.min(done, total).toLocaleString("en")} of ${total.toLocaleString("en")} items`
		: "Starting…";
	return (
		<span className="pk-extract-progress" aria-live="off">
			<progress
				className="pk-extract-bar"
				aria-label="Extraction progress"
				aria-valuetext={figure}
				max={counted ? total : undefined}
				value={counted ? Math.min(done, total) : undefined}
				data-testid="extract-progress"
			/>
			{/* The bar's value text already reads these words. */}
			<span className="pk-extract-figure" aria-hidden={true}>
				{figure}
			</span>
		</span>
	);
}
