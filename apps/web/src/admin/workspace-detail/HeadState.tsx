import type { AdminWorkspaceDetail } from "@portikus/contracts";
import { Button } from "@portikus/ui";
import { WorkspaceStateBadge } from "../WorkspaceStateBadge.js";
import {
	ACTION_LABEL,
	type LifecycleAction,
	lifecycleActions,
	useRunLifecycle,
} from "./lifecycle.js";

/** The state badge and the lifecycle buttons that fit it, under the name (SPEC.md §20.1). */
export function HeadState({
	detail,
	ownerName,
}: {
	detail: AdminWorkspaceDetail;
	ownerName: string;
}) {
	const { workspace } = detail;
	const lifecycle = useRunLifecycle();
	const { actions, waiting } = lifecycleActions(
		workspace.state,
		workspace.desiredState,
	);
	const archived = workspace.archivedAt !== null;
	const noteId = `lifecycle-note-${workspace.id}`;
	const archivedNote =
		archived && actions.includes("start")
			? "An archived workspace cannot start. Unarchive it first."
			: null;
	const note =
		[waiting ? `Waiting for the workspace to finish ${waiting}.` : null, archivedNote]
			.filter(Boolean)
			.join(" ") || null;
	const off = (action: LifecycleAction) => archived && action === "start";

	function runLifecycle(action: LifecycleAction) {
		if (off(action)) return;
		lifecycle.run(workspace.id, ownerName, action);
	}

	return (
		<>
			<div className="flex flex-wrap items-center gap-2">
				{/* Announces each state change while the panel refreshes. */}
				<span role="status" data-testid="detail-state">
					<WorkspaceStateBadge
						state={workspace.state}
						desiredState={workspace.desiredState}
						pendingOperation={workspace.pendingOperation}
						statusRole={false}
					/>
				</span>
				{archived ? <span className="pk-tag">Archived</span> : null}
			</div>
			<div className="pk-actions">
				{actions.map((action) => (
					<Button
						key={action}
						size="sm"
						data-testid={`detail-${action}`}
						aria-label={`${ACTION_LABEL[action]} ${ownerName}'s workspace`}
						aria-describedby={off(action) ? noteId : undefined}
						loading={lifecycle.pending === action}
						aria-disabled={lifecycle.pending || off(action) ? true : undefined}
						onClick={() => runLifecycle(action)}
					>
						{ACTION_LABEL[action]}
					</Button>
				))}
			</div>
			{note ? (
				<p
					id={noteId}
					className="pk-text-compact pk-muted m-0"
					data-testid="detail-lifecycle-note"
				>
					{note}
				</p>
			) : null}
		</>
	);
}
