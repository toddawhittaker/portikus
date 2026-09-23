import { z } from "zod";

/** Why a recovery point was made (SPEC.md §15.6). */
export const RecoveryReason = z.enum([
	"periodic",
	"manual",
	"before-archive",
	"before-restore",
	"before-rebuild",
	"agent-session",
]);
export type RecoveryReason = z.infer<typeof RecoveryReason>;

/** One recovery point of a project (SPEC.md §15.2, §26). */
export const RecoveryPoint = z.object({
	id: z.string().uuid(),
	projectId: z.string().uuid(),
	createdAt: z.string().datetime(),
	reason: RecoveryReason,
	sizeBytes: z.number().int().nonnegative(),
	expiresAt: z.string().datetime(),
});
export type RecoveryPoint = z.infer<typeof RecoveryPoint>;

/**
 * Response body for `GET /workspaces/:id/projects/:pid/recovery-points`,
 * newest first, with how much of the workspace's allowance is used
 * (SPEC.md §15.7, §19.2).
 */
export const RecoveryPointList = z.object({
	points: z.array(RecoveryPoint),
	usage: z.object({
		usedBytes: z.number().int().nonnegative(),
		quotaBytes: z.number().int().nonnegative(),
	}),
});
export type RecoveryPointList = z.infer<typeof RecoveryPointList>;

/**
 * Request body for `POST .../recovery-points/:rpid/restore` (SPEC.md §15.8).
 * `skipSafetyPoint` is honoured only after the safety point failed because
 * recovery storage is full.
 */
export const RestoreRecoveryPointRequest = z
	.object({
		skipSafetyPoint: z.boolean().optional(),
	})
	.strict();
export type RestoreRecoveryPointRequest = z.infer<typeof RestoreRecoveryPointRequest>;

/** Directories never put in a recovery point unless re-included (SPEC.md §15.5). */
export const DEFAULT_RECOVERY_EXCLUDES = [
	"node_modules/",
	".venv/",
	"dist/",
	"build/",
	"target/",
	"__pycache__/",
] as const;

/** Project-root file adding exclusions in `.gitignore` syntax (SPEC.md §15.5). */
export const WORKSPACEIGNORE_FILE = ".workspaceignore";

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, "Must be 64 hex characters");

/**
 * Request body for the agent's `POST /projects/:slug/recovery-points`.
 * When the new fingerprint equals `skipIfFingerprint`, nothing is written
 * (SPEC.md §15.6, ADR 0020).
 */
export const AgentCreateRecoveryPointRequest = z
	.object({
		projectId: z.string().uuid(),
		pointId: z.string().uuid(),
		skipIfFingerprint: Sha256.optional(),
	})
	.strict();
export type AgentCreateRecoveryPointRequest = z.infer<
	typeof AgentCreateRecoveryPointRequest
>;

/** Response body for the agent's create route. */
export const AgentCreateRecoveryPointResponse = z.discriminatedUnion("created", [
	z.object({
		created: z.literal(true),
		sizeBytes: z.number().int().nonnegative(),
		sha256: Sha256,
		fingerprint: Sha256,
	}),
	z.object({
		created: z.literal(false),
		fingerprint: Sha256,
	}),
]);
export type AgentCreateRecoveryPointResponse = z.infer<
	typeof AgentCreateRecoveryPointResponse
>;

/**
 * Request body for the agent's
 * `POST /projects/:slug/recovery-points/:pointId/restore`. The agent refuses
 * an archive whose hash differs (SPEC.md §24.6, ADR 0020).
 */
export const AgentRestoreRecoveryPointRequest = z
	.object({
		projectId: z.string().uuid(),
		sha256: Sha256,
	})
	.strict();
export type AgentRestoreRecoveryPointRequest = z.infer<
	typeof AgentRestoreRecoveryPointRequest
>;
