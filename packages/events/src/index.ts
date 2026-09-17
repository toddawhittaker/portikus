import { AgentErrorCode, Workspace } from "@portikus/contracts";
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

/**
 * Messages a browser sends on the terminal WebSocket (SPEC.md §9.1, §9.5).
 * Terminal output travels the other way as raw binary frames, not JSON.
 */
export const TerminalClientMessage = z.discriminatedUnion("type", [
	z.object({ type: z.literal("input"), data: z.string() }),
	z.object({
		type: z.literal("resize"),
		cols: z.number().int().min(1).max(1000),
		rows: z.number().int().min(1).max(1000),
	}),
]);
export type TerminalClientMessage = z.infer<typeof TerminalClientMessage>;

/**
 * Error codes carried on the terminal WebSocket: every agent code (SPEC.md
 * §27) plus `BAD_FRAME`, which describes the frame rather than the terminal
 * and so has no HTTP equivalent.
 */
export const TerminalErrorCode = z.union([AgentErrorCode, z.literal("BAD_FRAME")]);
export type TerminalErrorCode = z.infer<typeof TerminalErrorCode>;

/**
 * Text messages the API sends on the terminal WebSocket (SPEC.md §9.2, §27).
 */
export const TerminalServerMessage = z.discriminatedUnion("type", [
	z.object({ type: z.literal("exit") }),
	z.object({ type: z.literal("error"), code: TerminalErrorCode }),
]);
export type TerminalServerMessage = z.infer<typeof TerminalServerMessage>;
