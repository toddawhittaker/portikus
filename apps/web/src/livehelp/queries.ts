import { LiveHelpStatus, type StartLiveHelpRequest } from "@portikus/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { request, sendJson } from "../api/request.js";

/** Every live help query of one workspace starts with this key. */
const statusKey = (workspaceId: string) => ["live-help", workspaceId] as const;
const audienceKey = (workspaceId: string) =>
	[...statusKey(workspaceId), "audience"] as const;
const base = (workspaceId: string) => `/workspaces/${workspaceId}/live-help`;

/** How often the bar checks an open session, so an end from the other side shows within seconds (ADR 0063). */
const OPEN_POLL_MS = 5_000;
/** With nothing open, a slower check still finds a session started in another browser. */
const IDLE_POLL_MS = 30_000;

/** The bar's poll: the open session, if any, and why the last one ended. */
export function useLiveHelpStatus(workspaceId: string) {
	return useQuery({
		queryKey: statusKey(workspaceId),
		queryFn: () => request(LiveHelpStatus, base(workspaceId)),
		refetchInterval: (query) =>
			query.state.data?.session ? OPEN_POLL_MS : IDLE_POLL_MS,
	});
}

/** The start dialog's read, which also lists the instructors the student may ask. */
export function useLiveHelpAudience(workspaceId: string) {
	return useQuery({
		queryKey: audienceKey(workspaceId),
		queryFn: () => request(LiveHelpStatus, `${base(workspaceId)}?audience=1`),
	});
}

/** Every route answers the new status, so the bar's cache takes it as it is. */
function useStatusMutation<T>(
	workspaceId: string,
	send: (input: T) => Promise<LiveHelpStatus>,
) {
	const client = useQueryClient();
	return useMutation({
		mutationFn: send,
		onSuccess: (status) => client.setQueryData(statusKey(workspaceId), status),
		// A refusal means what is cached is out of date, so both reads run again.
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
