import { z } from "zod";

/** How many lines the workspace agent keeps of its own log (ADR 0060). */
export const AGENT_LOG_MAX_LINES = 200;

/** The agent's log ring holds at most this many bytes of kept lines (ADR 0060). */
export const AGENT_LOG_MAX_BYTES = 128 * 1024;

/**
 * The most the API reads of the agent's `/log` reply: the ring plus room for
 * JSON escaping. Anything longer is refused, not buffered (SPEC.md 24.1).
 */
export const AGENT_LOG_MAX_REPLY_BYTES = 2 * AGENT_LOG_MAX_BYTES;

/** The levels the ring keeps; quieter lines never leave the workspace. */
export const AGENT_LOG_LEVELS = ["warn", "error", "fatal"] as const;

/**
 * One line the workspace agent reports about itself. The agent is
 * untrusted, so only these fields are kept (SPEC.md 24.1).
 */
export const AgentLogLine = z
	.object({
		time: z.string().max(64),
		level: z.enum(AGENT_LOG_LEVELS),
		msg: z.string().max(AGENT_LOG_MAX_BYTES),
		code: z.string().max(200).optional(),
		status: z.number().int().optional(),
		durationMs: z.number().optional(),
	})
	.strict();
export type AgentLogLine = z.infer<typeof AgentLogLine>;

/** `GET /admin/workspaces/:id/agent-log`, and the agent's own `GET /log`. */
export const AgentLogResponse = z
	.object({ lines: z.array(AgentLogLine).max(AGENT_LOG_MAX_LINES) })
	.strict();
export type AgentLogResponse = z.infer<typeof AgentLogResponse>;
