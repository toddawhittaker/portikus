import type { AdminWorkspaceDetail } from "@portikus/contracts";
import { Button, useToast } from "@portikus/ui";
import { useEffect, useRef } from "react";
import { errorText } from "../../api/request.js";
import { useSetArchived } from "../queries.js";
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
	onFocusLost,
}: {
	detail: AdminWorkspaceDetail;
	ownerName: string;
	/** Called when the control that had focus went away, such as Unarchive once it worked. */
	onFocusLost: () => void;
}) {
	const { workspace } = detail;
	const lifecycle = useRunLifecycle();
	const toast = useToast();
	const archive = useSetArchived();
	const unarchiveRef = useRef<HTMLButtonElement>(null);
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

	// Archive and Unarchive each take their own button away once they work;
	// focus goes to the one that undoes it, or to the panel's heading (Gate E).
	const wasArchived = useRef(archived);
	useEffect(() => {
		if (wasArchived.current === archived) return;
		wasArchived.current = archived;
		const active = document.activeElement;
		if (active && active !== document.body) return;
		if (archived) unarchiveRef.current?.focus();
		else onFocusLost();
	}, [archived, onFocusLost]);

	function unarchive() {
		if (archive.isPending) return;
		archive.mutate(
			{ workspaceId: workspace.id, archived: false },
			{
				onSuccess: () => toast.show({ tone: "success", title: "Workspace unarchived" }),
				onError: (error) =>
					toast.show({
						tone: "danger",
						title: "Could not unarchive the workspace",
						children: errorText(error),
					}),
			},
		);
	}

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
				{archived ? (
					<Button
						ref={unarchiveRef}
						size="sm"
						data-testid="detail-unarchive"
						aria-label={`Unarchive workspace for ${ownerName}`}
						loading={archive.isPending}
						onClick={unarchive}
					>
						Unarchive
					</Button>
				) : null}
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
