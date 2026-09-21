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
		queryFn: async () =>
			(
				await request(
					z.object({ services: z.array(ListeningService) }),
					`/workspaces/${workspaceId}/listening`,
				)
			).services,
	});
	return query.data;
}

/**
 * Whether a port may be previewed at all (SPEC.md §14.7, §18.2).
 *
 * The API applies the port policy and reports the result as
 * `previewReachability`, so this is the one place that decides it.
 */
export function isPreviewable(service: ListeningService): boolean {
	return service.previewReachability !== "denied";
}

/** How the Running surface names what is using a port (SPEC.md §18.2). */
export function serviceCommand(service: ListeningService): string {
	return service.container?.name ?? service.process?.command ?? "unknown";
}

/** True when the port belongs to an inner Docker container (SPEC.md §18.2). */
export function isDocker(service: ListeningService): boolean {
	return service.container !== undefined;
}

/**
 * Why a row offers no actions, or null when it does (issues #265, #272).
 * A reserved port is one the preview policy refuses; a system service is one
 * the agent attributes to the platform or a system account.
 */
export function serviceReason(service: ListeningService): string | null {
	if (service.system) return "system service";
	if (service.previewReachability === "denied") return "reserved port";
	return null;
}

/** Ask the workspace to stop what holds a port (SPEC.md §18.2, issue #273). */
export async function stopListener(workspaceId: string, port: number): Promise<void> {
	await request(z.unknown(), `/workspaces/${workspaceId}/listening/${port}/stop`, {
		method: "POST",
	});
}

/** Where the "Show system services" choice is remembered (issue #265). */
const SHOW_SYSTEM_KEY = "pk-running-show-system";

export function readShowSystem(): boolean {
	try {
		return localStorage.getItem(SHOW_SYSTEM_KEY) === "true";
	} catch {
		// Some browsers refuse storage; the default is to hide them.
		return false;
	}
}

export function writeShowSystem(show: boolean): void {
	try {
		localStorage.setItem(SHOW_SYSTEM_KEY, show ? "true" : "false");
	} catch {
		// Nothing to remember is not worth telling the student about.
	}
}
