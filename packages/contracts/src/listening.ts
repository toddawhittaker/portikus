import { z } from "zod";
import { PROCESS_COMMAND_LINE_LIMIT } from "./usage.js";

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
	/**
	 * True once `protocolHint` is final for this socket: the agent has probed
	 * it for TLS, or it is a port the agent never probes. The probe runs only
	 * when a preview of the port is first asked for, so until
	 * then the hint is a guess from the port number.
	 */
	protocolKnown: z.boolean().optional(),
	process: z
		.object({
			pid: z.number().int().optional(),
			/** `/proc/<pid>/comm`. A thread name, so Python often reads MainThread. */
			command: z.string().optional(),
			/**
			 * `/proc/<pid>/cmdline` with the NUL separators turned into spaces.
			 * Absent when it could not be read. Arguments can carry secrets,
			 * so this is never logged. Cut to the limit rather than rejected,
			 * so an older agent's long value does not fail the whole listener.
			 */
			commandLine: z
				.string()
				.transform((line) => line.slice(0, PROCESS_COMMAND_LINE_LIMIT))
				.optional(),
		})
		.optional(),
	container: z
		.object({ id: z.string().optional(), name: z.string().optional() })
		.optional(),
	previewReachability: z.enum(["reachable", "forwarded", "denied", "unknown"]),
	/**
	 * True when the listener belongs to the platform or to a system account
	 * rather than to the student (SPEC.md §18.2). The Running pane hides these
	 * by default; authorization does not look at this flag.
	 */
	system: z.boolean().default(false),
	observedAt: z.string(),
});
export type ListeningService = z.infer<typeof ListeningService>;

/**
 * What the agent itself reports. Nothing inside the container is told the
 * workspace id, so the control plane stamps it on when it relays the list.
 */
export const AgentListeningService = ListeningService.omit({ workspaceId: true });
export type AgentListeningService = z.infer<typeof AgentListeningService>;

/**
 * Most listeners one workspace reports. A student container has a handful;
 * 1024 leaves room for odd cases while bounding the work a frame costs the API.
 */
export const MAX_LISTENING_SERVICES = 1024;

/** The set of listening services changed (BROWSER-HANDLING.md §17). */
export const ListeningServicesChanged = z.object({
	type: z.literal("workspace.listening-services.changed"),
	workspaceId: z.string(),
	services: z.array(ListeningService).max(MAX_LISTENING_SERVICES),
	observedAt: z.string(),
});
export type ListeningServicesChanged = z.infer<typeof ListeningServicesChanged>;

/** The same frame as the agent sends it, without the workspace id. */
export const AgentListeningServicesChanged = ListeningServicesChanged.omit({
	workspaceId: true,
}).extend({
	services: z.array(AgentListeningService).max(MAX_LISTENING_SERVICES),
});
export type AgentListeningServicesChanged = z.infer<
	typeof AgentListeningServicesChanged
>;

/** Body of `POST /listening/:port/stop` has no fields; this is its reply. */
export const StopListenerResponse = z.object({
	port: PortNumber,
	stopped: z.literal(true),
});
export type StopListenerResponse = z.infer<typeof StopListenerResponse>;

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
