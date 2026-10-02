import type { AdminWorkspaceDetail } from "@portikus/contracts";
import {
	Button,
	type DesiredState,
	resolveWorkspaceState,
	useToast,
	type WorkspaceState,
} from "@portikus/ui";
import { errorText } from "../../api/request.js";
import { useLifecycleAction } from "../queries.js";
import { KNOWN_STATES, WorkspaceStateBadge } from "../WorkspaceStateBadge.js";

export type LifecycleAction = "start" | "stop" | "restart";

/**
 * The lifecycle buttons that make sense now, and, during a transition, the
 * word for what the workspace is doing ("starting"). A transition keeps the
 * opposite action, so an admin can rescue a stuck workspace.
 */
export function lifecycleActions(
	state: string,
	desiredState: string,
): { actions: LifecycleAction[]; waiting: string | null } {
	if (!KNOWN_STATES.includes(state)) {
		return { actions: ["start", "stop", "restart"], waiting: null };
	}
	const resolved = resolveWorkspaceState(
		state as WorkspaceState,
		desiredState as DesiredState,
	);
	if (resolved.moving) {
		return {
			actions: desiredState === "stopped" ? ["start"] : ["stop", "restart"],
			waiting: resolved.label.toLowerCase(),
		};
	}
	return {
		actions: state === "running" ? ["stop", "restart"] : ["start"],
		waiting: null,
	};
}

/** The state badge and the lifecycle buttons that fit it, under the name (SPEC.md §20.1). */
export function HeadState({
	detail,
	ownerName,
}: {
	detail: AdminWorkspaceDetail;
	ownerName: string;
}) {
	const { workspace } = detail;
	const toast = useToast();
	const lifecycle = useLifecycleAction();
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
		if (lifecycle.isPending || off(action)) return;
		lifecycle.mutate(
			{ workspaceId: workspace.id, action },
			{
				onSuccess: () =>
					toast.show({
						tone: "success",
						title: `${ACTION_DONE[action]} ${ownerName}'s workspace`,
					}),
				onError: (error) =>
					toast.show({
						tone: "danger",
						title: `Could not ${action} the workspace`,
						children: errorText(error),
					}),
			},
		);
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
						loading={lifecycle.isPending && lifecycle.variables?.action === action}
						aria-disabled={lifecycle.isPending || off(action) ? true : undefined}
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

const ACTION_LABEL = { start: "Start", stop: "Stop", restart: "Restart" } as const;
const ACTION_DONE = {
	start: "Asked to start",
	stop: "Asked to stop",
	restart: "Asked to restart",
} as const;
