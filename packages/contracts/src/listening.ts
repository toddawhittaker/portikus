import { z } from "zod";

/** A TCP port number. */
export const PortNumber = z.number().int().min(1).max(65535);

/**
 * One TCP service listening inside a workspace, as discovered by the
 * workspace agent (BROWSER-HANDLING.md §11.1, SPEC.md §14.7, §18.2).
 *
 * `previewReachability` is "reachable" when the service is bound to an
 * address the preview gateway can reach, "forwarded" when it is bound only
 * to loopback and the agent has a loopback forward open for it, and
 * "denied" when policy refuses the port. Only the control plane can say
 * "denied", so the agent never reports it.
 */
export const ListeningService = z.object({
	workspaceId: z.string(),
	port: PortNumber,
	addresses: z.array(z.string()),
	protocolHint: z.enum(["http", "https", "unknown"]),
	process: z
		.object({ pid: z.number().int().optional(), command: z.string().optional() })
		.optional(),
	container: z
		.object({ id: z.string().optional(), name: z.string().optional() })
		.optional(),
	previewReachability: z.enum(["reachable", "forwarded", "denied", "unknown"]),
	observedAt: z.string(),
});
export type ListeningService = z.infer<typeof ListeningService>;

/**
 * What the agent itself reports. Nothing inside the container is told the
 * workspace id, so the control plane stamps it on when it relays the list.
 */
export const AgentListeningService = ListeningService.omit({ workspaceId: true });
export type AgentListeningService = z.infer<typeof AgentListeningService>;

/** The set of listening services changed (BROWSER-HANDLING.md §17). */
export const ListeningServicesChanged = z.object({
	type: z.literal("workspace.listening-services.changed"),
	workspaceId: z.string(),
	services: z.array(ListeningService),
	observedAt: z.string(),
});
export type ListeningServicesChanged = z.infer<typeof ListeningServicesChanged>;

/** The same frame as the agent sends it, without the workspace id. */
export const AgentListeningServicesChanged = ListeningServicesChanged.omit({
	workspaceId: true,
}).extend({ services: z.array(AgentListeningService) });
export type AgentListeningServicesChanged = z.infer<
	typeof AgentListeningServicesChanged
>;

/** Body of `POST /forwards` on the agent (BROWSER-HANDLING.md §11.1). */
export const LoopbackForwardRequest = z.object({ port: PortNumber });
export type LoopbackForwardRequest = z.infer<typeof LoopbackForwardRequest>;

/** One loopback forward the agent has open. */
export const LoopbackForward = z.object({
	port: PortNumber,
	address: z.string(),
	state: z.enum(["open", "closed"]),
});
export type LoopbackForward = z.infer<typeof LoopbackForward>;
