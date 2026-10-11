import { z } from "zod";

/**
 * Stopping one process in a workspace (SPEC.md §18.3). The start ticks come
 * from the usage sample, so a PID the
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

/** One process by PID and start ticks, so a reused PID is refused. */
export const ProcessIdentity = z
	.object({
		pid: z
			.number()
			.int()
			.positive()
			.max(2 ** 31 - 1),
		startTicks: z.number().int().nonnegative(),
	})
	.strict();
export type ProcessIdentity = z.infer<typeof ProcessIdentity>;

/** The most processes one tree stop names. */
export const PROCESS_TREE_LIMIT = 1024;

/**
 * "Stop with children" in Monitor (SPEC.md §18.3). Without `remaining` the
 * agent stops the tree it finds below the root. The root has usually exited
 * by the time a student presses Force stop, so that press sends back the
 * `remaining` list from the first answer, and the agent checks and signals
 * exactly those.
 */
export const ProcessTreeStopRequest = z
	.object({
		startTicks: z.number().int().nonnegative(),
		force: z.boolean().default(false),
		remaining: z.array(ProcessIdentity).max(PROCESS_TREE_LIMIT).optional(),
	})
	.strict();
export type ProcessTreeStopRequest = z.infer<typeof ProcessTreeStopRequest>;

/**
 * `signalled` counts the processes the signal reached, the root included;
 * `refused` the members left alone because they are protected. `exited`
 * false means `remaining` outlived the grace; offer Force stop.
 */
export const ProcessTreeStopResponse = z
	.object({
		pid: z.number().int().positive(),
		exited: z.boolean(),
		signalled: z.number().int().nonnegative(),
		refused: z.number().int().nonnegative(),
		remaining: z.array(ProcessIdentity).max(PROCESS_TREE_LIMIT),
	})
	.strict();
export type ProcessTreeStopResponse = z.infer<typeof ProcessTreeStopResponse>;

/** "Lower priority" in Monitor: nice +10, capped at 19, for the process tree. */
export const ProcessPriorityRequest = z
	.object({ startTicks: z.number().int().nonnegative() })
	.strict();
export type ProcessPriorityRequest = z.infer<typeof ProcessPriorityRequest>;

/** `lowered` counts the processes made less favoured; one already at 19 is not counted. */
export const ProcessPriorityResponse = z
	.object({
		pid: z.number().int().positive(),
		lowered: z.number().int().nonnegative(),
		refused: z.number().int().nonnegative(),
	})
	.strict();
export type ProcessPriorityResponse = z.infer<typeof ProcessPriorityResponse>;

/** The refusals the agent answers and the API passes on unchanged. */
export const ProcessStopErrorCode = z.enum([
	"PROCESS_NOT_FOUND",
	"PROCESS_CHANGED",
	"PROCESS_PROTECTED",
]);
export type ProcessStopErrorCode = z.infer<typeof ProcessStopErrorCode>;

/**
 * The processes the agent's stop refuses beyond PID 1 and other users'
 * processes (ADR 0037): the agent, its attach clients, tmux and the pane
 * shells. The worker marks these protected in the administrator's list.
 */
export const AgentProtectedProcesses = z
	.object({
		processes: z
			.array(
				z
					.object({
						pid: z.number().int().positive(),
						startTicks: z.number().int().nonnegative(),
					})
					.strict(),
			)
			.max(10_000),
	})
	.strict();
export type AgentProtectedProcesses = z.infer<typeof AgentProtectedProcesses>;
