import type { CheckHistoryEntry } from "@portikus/contracts";
import { Button, StateBadge } from "@portikus/ui";
import { useState } from "react";
import { CHECK_BADGE } from "./checkBadge.js";
import { formatDuration, plainOutput } from "./historyText.js";
import { useCheckHistory, useCheckHistoryOutput } from "./queries.js";

const WHEN = new Intl.DateTimeFormat(undefined, {
	dateStyle: "medium",
	timeStyle: "short",
});

/**
 * The kept runs of one check, newest first, so a student can show that a
 * check passed earlier even after the workspace restarted (SPEC.md §18.1, §25).
 */
export function CheckHistory({
	workspaceId,
	projectId,
	checkId,
	name,
}: {
	workspaceId: string;
	projectId: string;
	checkId: string;
	name: string;
}) {
	const history = useCheckHistory(workspaceId, projectId, checkId);
	const runs = history.data?.runs ?? [];
	return (
		<section
			className="pk-check-history"
			aria-labelledby="check-history-title"
			data-testid="check-history"
		>
			<h3 className="pk-check-history-head" id="check-history-title">
				History <span className="pk-check-panel-name">{name}</span>
			</h3>
			{history.isError ? (
				<p className="pk-hint" data-testid="check-history-error">
					The history could not be loaded.
				</p>
			) : runs.length === 0 ? (
				<p className="pk-hint" data-testid="check-history-empty">
					{history.isPending ? "Loading…" : "No finished runs yet."}
				</p>
			) : (
				<ol className="pk-check-history-list" data-testid="check-history-list">
					{runs.map((run) => (
						<HistoryRow
							key={run.id}
							workspaceId={workspaceId}
							projectId={projectId}
							run={run}
						/>
					))}
				</ol>
			)}
		</section>
	);
}

function HistoryRow({
	workspaceId,
	projectId,
	run,
}: {
	workspaceId: string;
	projectId: string;
	run: CheckHistoryEntry;
}) {
	const [open, setOpen] = useState(false);
	const output = useCheckHistoryOutput(
		workspaceId,
		projectId,
		run.checkId,
		run.id,
		open,
	);
	const badge = CHECK_BADGE[run.state];
	const when = WHEN.format(new Date(run.startedAt));
	const outputId = `check-history-output-${run.id}`;
	return (
		<li className="pk-check-history-item" data-testid="check-history-item">
			<div className="pk-check-history-row">
				<StateBadge state={badge.state} label={badge.label} />
				<time dateTime={run.startedAt} className="pk-check-history-when">
					{when}
				</time>
				<span className="pk-check-history-meta">
					{formatDuration(run.durationMs)}
					{run.exitCode === null ? "" : `, exit code ${run.exitCode}`}
				</span>
				<Button
					variant="quiet"
					size="sm"
					className="pk-check-history-toggle"
					aria-expanded={open}
					aria-controls={outputId}
					onClick={() => setOpen(!open)}
				>
					{open ? "Hide output" : "Show output"}
					<span className="sr-only"> of the run at {when}</span>
				</Button>
			</div>
			{open && (
				<div id={outputId}>
					{output.isError ? (
						<p className="pk-hint" role="status">
							The output of this run is no longer kept.
						</p>
					) : output.data === undefined ? (
						<p className="pk-hint" role="status">
							Loading…
						</p>
					) : (
						// Focusable so keyboard users can scroll long output in every browser (SPEC.md §25.8).
						// biome-ignore lint/a11y/useSemanticElements: a pre cannot be a fieldset; the role lets it carry a name
						<pre
							className="pk-check-history-output pk-focus-inset"
							data-testid="check-history-output"
							// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling box must be reachable by keyboard
							tabIndex={0}
							role="group"
							aria-label={`Output of the run at ${when}`}
						>
							{plainOutput(output.data) || "(no output)"}
						</pre>
					)}
				</div>
			)}
		</li>
	);
}
