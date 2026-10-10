import { z } from "zod";

/**
 * One line the workspace agent reports about itself. The agent is
 * untrusted, so only these fields are kept (SPEC.md 24.1).
 */
export const AgentLogLine = z
	.object({
		time: z.string(),
		level: z.string(),
		msg: z.string(),
		code: z.string().optional(),
		status: z.number().int().optional(),
		durationMs: z.number().optional(),
	})
	.strict();
export type AgentLogLine = z.infer<typeof AgentLogLine>;

/** `GET /admin/workspaces/:id/agent-log`. */
export const AgentLogResponse = z.object({ lines: z.array(AgentLogLine) }).strict();
export type AgentLogResponse = z.infer<typeof AgentLogResponse>;
