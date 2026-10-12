import { LiveHelpStatus, type StartLiveHelpRequest } from "@portikus/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { request, sendJson } from "../api/request.js";

const statusKey = (workspaceId: string) => ["live-help", workspaceId] as const;
const base = (workspaceId: string) => `/workspaces/${workspaceId}/live-help`;

/** How often the bar checks an open session, so an end from the other side shows within seconds (ADR 0063). */
const OPEN_POLL_MS = 5_000;
/** With nothing open, a slower check still finds a session started in another browser. */
const IDLE_POLL_MS = 30_000;

/** The student's live help status: the open session, if any, and who they may ask. */
export function useLiveHelpStatus(workspaceId: string, enabled = true) {
	return useQuery({
		queryKey: statusKey(workspaceId),
		enabled,
		queryFn: () => request(LiveHelpStatus, base(workspaceId)),
		refetchInterval: (query) =>
			query.state.data?.session ? OPEN_POLL_MS : IDLE_POLL_MS,
	});
}

/** Every route answers the new status, so the cache takes it as it is. */
function useStatusMutation<T>(
	workspaceId: string,
	send: (input: T) => Promise<LiveHelpStatus>,
) {
	const client = useQueryClient();
	return useMutation({
		mutationFn: send,
		onSuccess: (status) => client.setQueryData(statusKey(workspaceId), status),
		// A refusal means the cached status is out of date, so read it again.
		onError: () => client.invalidateQueries({ queryKey: statusKey(workspaceId) }),
	});
}

export function useStartLiveHelp(workspaceId: string, projectId: string) {
	return useStatusMutation(workspaceId, (body: StartLiveHelpRequest) =>
		sendJson(
			LiveHelpStatus,
			`/workspaces/${workspaceId}/projects/${projectId}/live-help`,
			body,
		),
	);
}

export function useLiveHelpTyping(workspaceId: string) {
	return useStatusMutation(workspaceId, (typing: boolean) =>
		sendJson(LiveHelpStatus, `${base(workspaceId)}/typing`, { typing }),
	);
}

export function useStopLiveHelp(workspaceId: string) {
	return useStatusMutation(workspaceId, () =>
		request(LiveHelpStatus, `${base(workspaceId)}/stop`, { method: "POST" }),
	);
}
