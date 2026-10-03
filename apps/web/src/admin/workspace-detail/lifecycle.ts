import { DesiredState, WorkspaceState } from "@portikus/contracts";
import { resolveWorkspaceState, useToast } from "@portikus/ui";
import { errorText } from "../../api/request.js";
import { useLifecycleAction } from "../queries.js";

export type LifecycleAction = "start" | "stop" | "restart";

export const ACTION_LABEL = {
	start: "Start",
	stop: "Stop",
	restart: "Restart",
} as const;

const ACTION_DONE = {
	start: "Asked to start",
	stop: "Asked to stop",
	restart: "Asked to restart",
} as const;

/**
 * The lifecycle buttons that make sense now, and, during a transition, the
 * word for what the workspace is doing ("starting"). A transition keeps the
 * opposite action, so an admin can rescue a stuck workspace.
 */
export function lifecycleActions(
	state: string,
	desiredState: string,
): { actions: LifecycleAction[]; waiting: string | null } {
	const known = WorkspaceState.safeParse(state);
	if (!known.success) {
		return { actions: ["start", "stop", "restart"], waiting: null };
	}
	const resolved = resolveWorkspaceState(
		known.data,
		DesiredState.safeParse(desiredState).data,
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

/**
 * Start, stop or restart one workspace and say how it went in a toast. The
 * detail panel and the Users row menu both use it (SPEC.md section 20.1).
 */
export function useRunLifecycle() {
	const toast = useToast();
	const lifecycle = useLifecycleAction();

	function run(workspaceId: string, ownerName: string, action: LifecycleAction) {
		if (lifecycle.isPending) return;
		lifecycle.mutate(
			{ workspaceId, action },
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

	return {
		run,
		/** The action in flight, if any. */
		pending: lifecycle.isPending ? (lifecycle.variables?.action ?? null) : null,
	};
}
