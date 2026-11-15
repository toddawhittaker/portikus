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
						<p className="pk-hint">The output of this run is no longer kept.</p>
					) : output.data === undefined ? (
						<p className="pk-hint">Loading…</p>
					) : (
						<pre className="pk-check-history-output" data-testid="check-history-output">
							{plainOutput(output.data) || "(no output)"}
						</pre>
					)}
				</div>
			)}
		</li>
	);
}
