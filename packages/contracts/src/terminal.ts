import { z } from "zod";
import { TerminalTheme } from "./settings.js";

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
 * Which coding agent a launcher started in this terminal (SPEC.md §10.1).
 * An ordinary shell has no value.
 */
export const CodingAgent = z.enum(["claude", "codex"]);
export type CodingAgent = z.infer<typeof CodingAgent>;

/**
 * Full object id from Git: `git stash create` for the review baseline, or
 * the HEAD that baseline was taken against (SPEC.md §10.9). SHA-1 or SHA-256.
 * Not a second snapshot format.
 */
const GitObjectId = z.string().regex(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/);

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
	projectId: z.string().uuid().nullable(),
	createdAt: z.string().datetime(),
	endedAt: z.string().datetime().nullable(),
	/** This terminal's own colour scheme (issue #268). */
	theme: TerminalTheme,
	/**
	 * Set when a launcher started a coding agent here (SPEC.md §10.8).
	 * Absent on rows written before Epic 9.
	 */
	agent: CodingAgent.nullable().optional(),
	/** Object id from `git stash create` before the agent ran (SPEC.md §10.9). */
	baselineObjectId: GitObjectId.nullable().optional(),
	/** HEAD at the moment that baseline was taken (SPEC.md §10.9, §12.7). */
	baselineHead: GitObjectId.nullable().optional(),
	/** Recovery point made before the agent session started (SPEC.md §10.9). */
	recoveryPointId: z.string().uuid().nullable().optional(),
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
		projectId: z.string().uuid().optional(),
		/** Defaults to the user's terminal colour scheme (issue #268). */
		theme: TerminalTheme.optional(),
		/**
		 * Present when the center-pane launcher is starting Claude or Codex
		 * (SPEC.md §10.2). There is no command string: the server picks the CLI.
		 */
		agent: CodingAgent.optional(),
	})
	.strict();
export type CreateTerminalRequest = z.infer<typeof CreateTerminalRequest>;

/**
 * Request body for `PATCH /workspaces/:id/terminals/:terminalId`
 * (SPEC.md §9.6). It changes the display name, the colour scheme, or both;
 * a request that changes nothing is rejected.
 */
export const UpdateTerminalRequest = z
	.object({
		name: z.string().min(1).max(64).optional(),
		theme: TerminalTheme.optional(),
	})
	.strict()
	.refine((body) => body.name !== undefined || body.theme !== undefined, {
		message: "At least one field must be given",
	});
export type UpdateTerminalRequest = z.infer<typeof UpdateTerminalRequest>;

/** Response body for `GET /workspaces/:id/terminals` (SPEC.md §26). */
export const TerminalList = z.object({
	terminals: z.array(Terminal),
});
export type TerminalList = z.infer<typeof TerminalList>;
