import { z } from "zod";
import { TerminalId } from "./terminal.js";

/**
 * Response body for `GET /health` on the workspace agent
 * (SPEC.md §26; STACK.md §10).
 */
export const AgentHealthResponse = z.object({
	ok: z.literal(true),
});
export type AgentHealthResponse = z.infer<typeof AgentHealthResponse>;

/**
 * A terminal as the agent knows it: the tmux session and how many browser
 * attachments it currently has (SPEC.md §9.5, §26).
 */
export const AgentTerminal = z.object({
	id: TerminalId,
	cwd: z.string().min(1),
	attachments: z.number().int().nonnegative(),
});
export type AgentTerminal = z.infer<typeof AgentTerminal>;

/** Response body for `GET /terminals` on the agent (SPEC.md §26). */
export const AgentTerminalList = z.object({
	terminals: z.array(AgentTerminal),
});
export type AgentTerminalList = z.infer<typeof AgentTerminalList>;

/**
 * Request body for `POST /terminals` on the agent (SPEC.md §9.3, §9.4).
 * The control plane mints the id, so the agent never invents one.
 */
export const AgentCreateTerminalRequest = z
	.object({
		id: TerminalId,
		cwd: z.string().min(1),
	})
	.strict();
export type AgentCreateTerminalRequest = z.infer<typeof AgentCreateTerminalRequest>;

/** Error codes returned by the workspace agent (SPEC.md §27; STACK.md §10). */
export const AgentErrorCode = z.enum([
	"UNAUTHORIZED",
	"TERMINAL_NOT_FOUND",
	"TERMINAL_EXISTS",
	"TERMINAL_LIMIT",
	"ATTACHMENT_LIMIT",
	"INVALID_CWD",
	"TMUX_FAILED",
]);
export type AgentErrorCode = z.infer<typeof AgentErrorCode>;

/** Standard error response from the workspace agent (SPEC.md §27). */
export const AgentError = z.object({
	error: z.object({
		code: AgentErrorCode,
		message: z.string(),
	}),
});
export type AgentError = z.infer<typeof AgentError>;
