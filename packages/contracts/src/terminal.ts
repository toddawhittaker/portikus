import { z } from "zod";

/** Maximum terminals a single workspace may have open (SPEC.md §9.3). */
export const MAX_TERMINALS_PER_WORKSPACE = 8;

/** Maximum browser attachments to one terminal (SPEC.md §9.5). */
export const MAX_ATTACHMENTS_PER_TERMINAL = 4;

/** Maximum bytes accepted in one terminal input frame (SPEC.md §24.2). */
export const MAX_INPUT_FRAME_BYTES = 65536;

/** Identifier of a terminal, minted by the control plane (SPEC.md §26). */
export const TerminalId = z.string().uuid();
export type TerminalId = z.infer<typeof TerminalId>;

/**
 * Terminal metadata persisted by the control plane (SPEC.md §9.6, §26).
 * The process itself is not persisted across a full workspace stop.
 */
export const Terminal = z.object({
	id: TerminalId,
	workspaceId: z.string().uuid(),
	name: z.string().min(1).max(64),
	cwd: z.string().min(1),
	position: z.number().int().nonnegative(),
	createdAt: z.string().datetime(),
	endedAt: z.string().datetime().nullable(),
});
export type Terminal = z.infer<typeof Terminal>;

/**
 * Request body for `POST /workspaces/:id/terminals` (SPEC.md §9.3, §9.4).
 * Both fields are optional; the server fills in a default name and the
 * workspace home directory.
 */
export const CreateTerminalRequest = z
	.object({
		name: z.string().min(1).max(64).optional(),
		cwd: z.string().min(1).optional(),
	})
	.strict();
export type CreateTerminalRequest = z.infer<typeof CreateTerminalRequest>;

/**
 * Request body for `PATCH /workspaces/:id/terminals/:terminalId`
 * (SPEC.md §9.6).
 */
export const RenameTerminalRequest = z
	.object({
		name: z.string().min(1).max(64),
	})
	.strict();
export type RenameTerminalRequest = z.infer<typeof RenameTerminalRequest>;

/** Response body for `GET /workspaces/:id/terminals` (SPEC.md §26). */
export const TerminalList = z.object({
	terminals: z.array(Terminal),
});
export type TerminalList = z.infer<typeof TerminalList>;
