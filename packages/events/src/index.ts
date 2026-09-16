import { Workspace } from "@portikus/contracts";
import { z } from "zod";

/**
 * Messages a browser sends on the workspace WebSocket (SPEC.md §5.4, §6.4).
 * The heartbeat is what keeps the connection counted as present.
 */
export const ClientMessage = z.object({ type: z.literal("heartbeat") });
export type ClientMessage = z.infer<typeof ClientMessage>;

/** Messages the API sends on the workspace WebSocket (SPEC.md §6.4). */
export const ServerMessage = z.discriminatedUnion("type", [
	z.object({ type: z.literal("workspace"), workspace: Workspace }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;
