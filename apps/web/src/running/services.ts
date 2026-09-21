/**
 * The ports listening inside one workspace (SPEC.md §18.2, §14.7).
 *
 * The list arrives twice over: once from `GET /workspaces/:id/listening`
 * when the screen opens, and after that from the workspace WebSocket
 * whenever the agent notices a change. The socket copy wins, because it is
 * the newer of the two.
 */
import { ListeningService } from "@portikus/contracts";
import { useQuery } from "@tanstack/react-query";
import { createContext, useContext } from "react";
import { z } from "zod";
import { request } from "../api/request.js";
import { MIN_PREVIEW_PORT } from "../preview/grants.js";

export interface Listening {
	services: ListeningService[];
	/** False until the first list, so "nothing is running" is not shown early. */
	loaded: boolean;
}

/**
 * What the workspace screen knows about listening ports. A component
 * rendered outside a workspace sees an empty list that never loads.
 */
export const ListeningContext = createContext<Listening>({
	services: [],
	loaded: false,
});

export function useListening(): Listening {
	return useContext(ListeningContext);
}

/** The first list, before the socket has anything to say. */
export function useListeningQuery(
	workspaceId: string,
	enabled: boolean,
): ListeningService[] | undefined {
	const query = useQuery({
		queryKey: ["listening", workspaceId],
		enabled,
		queryFn: () =>
			request(z.array(ListeningService), `/workspaces/${workspaceId}/listening`),
	});
	return query.data;
}

/** Whether a port may be previewed at all (SPEC.md §14.7, §18.2). */
export function isPreviewable(service: ListeningService): boolean {
	return service.previewReachability !== "denied" && service.port >= MIN_PREVIEW_PORT;
}

/** How the Running surface names what is using a port (SPEC.md §18.2). */
export function serviceCommand(service: ListeningService): string {
	return service.container?.name ?? service.process?.command ?? "unknown";
}

/** "Docker" when the port belongs to inner Docker, else "Preview". */
export function serviceKind(service: ListeningService): "Docker" | "Preview" {
	return service.container ? "Docker" : "Preview";
}
