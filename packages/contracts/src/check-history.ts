import { z } from "zod";
import { CheckId } from "./checks.js";

/**
 * Finished check runs the control plane keeps, so a result outlives the
 * workspace agent ("Check result metadata", SPEC.md §25; §18.1).
 */

/** Finished runs kept per check per project; the oldest go first. */
export const CHECK_HISTORY_PER_CHECK = 20;

/** Most output one stored run keeps; the tail is kept, as the replay buffer does. */
export const MAX_STORED_CHECK_OUTPUT_BYTES = 64 * 1024;

/** How a finished run ended. A running check has no history entry yet. */
export const FinishedCheckState = z.enum(["passed", "failed", "error", "stopped"]);
export type FinishedCheckState = z.infer<typeof FinishedCheckState>;

/** Base64 of at most MAX_STORED_CHECK_OUTPUT_BYTES bytes. */
const StoredOutput = z
	.string()
	.max(Math.ceil(MAX_STORED_CHECK_OUTPUT_BYTES / 3) * 4)
	.regex(/^[A-Za-z0-9+/]*={0,2}$/);

/**
 * One finished run as the workspace agent reports it to the control plane.
 * `id` is the agent's own run id, so reading the same run twice stores it once.
 */
export const FinishedCheckRun = z.object({
	id: z.string().min(1).max(64),
	checkId: CheckId,
	state: FinishedCheckState,
	startedAt: z.string().datetime(),
	endedAt: z.string().datetime(),
	exitCode: z.number().int().nullable(),
	output: StoredOutput,
});
export type FinishedCheckRun = z.infer<typeof FinishedCheckRun>;

/**
 * Finished runs one workspace agent holds for the control plane to read,
 * over all its projects; the oldest go first. 100 runs of 64 KiB is 6.4 MiB.
 */
export const MAX_HELD_FINISHED_RUNS = 100;

/** `GET /projects/:slug/checks/finished` on the workspace agent, oldest first. */
export const FinishedCheckRunsResponse = z.object({
	runs: z.array(FinishedCheckRun).max(MAX_HELD_FINISHED_RUNS),
});
export type FinishedCheckRunsResponse = z.infer<typeof FinishedCheckRunsResponse>;

/** One stored run, as the browser lists it. Output is fetched on its own. */
export const CheckHistoryEntry = z.object({
	id: z.string().uuid(),
	checkId: CheckId,
	state: FinishedCheckState,
	startedAt: z.string(),
	endedAt: z.string(),
	durationMs: z.number().int().nonnegative(),
	exitCode: z.number().int().nullable(),
});
export type CheckHistoryEntry = z.infer<typeof CheckHistoryEntry>;

/** `GET /workspaces/:id/projects/:pid/checks/:checkId/history`, newest first. */
export const CheckHistoryResponse = z.object({
	runs: z.array(CheckHistoryEntry).max(CHECK_HISTORY_PER_CHECK),
});
export type CheckHistoryResponse = z.infer<typeof CheckHistoryResponse>;

/** `GET .../checks/:checkId/history/:runId/output`: the kept tail, base64. */
export const CheckHistoryOutput = z.object({ output: StoredOutput });
export type CheckHistoryOutput = z.infer<typeof CheckHistoryOutput>;
