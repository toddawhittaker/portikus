import { z } from "zod";

/**
 * Stopping one process in a workspace (SPEC.md §18.3; docs/EPIC-21.md
 * ruling 8). The start ticks come from the usage sample, so a PID the
 * kernel has since given to another program is refused, not signalled.
 */
export const ProcessStopRequest = z
	.object({
		startTicks: z.number().int().nonnegative(),
		/** SIGKILL instead of SIGTERM. Only ever sent when the student asks. */
		force: z.boolean().default(false),
	})
	.strict();
export type ProcessStopRequest = z.infer<typeof ProcessStopRequest>;

/** `exited` false means the process outlived the grace; offer Force stop. */
export const ProcessStopResponse = z
	.object({
		pid: z.number().int().positive(),
		exited: z.boolean(),
	})
	.strict();
export type ProcessStopResponse = z.infer<typeof ProcessStopResponse>;

/** The refusals the agent answers and the API passes on unchanged. */
export const ProcessStopErrorCode = z.enum([
	"PROCESS_NOT_FOUND",
	"PROCESS_CHANGED",
	"PROCESS_PROTECTED",
]);
export type ProcessStopErrorCode = z.infer<typeof ProcessStopErrorCode>;
