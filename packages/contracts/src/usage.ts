import { z } from "zod";

/** The longest command line a usage sample carries. */
export const PROCESS_COMMAND_LINE_LIMIT = 1024;

/**
 * One process inside the workspace (SPEC.md §18.2, §18.3).
 *
 * `command` is the short name from `/proc/<pid>/status`. Arguments can carry
 * secrets, so `commandLine` is filled only for the student's own processes,
 * goes only to the student, and is never logged or audited (STACK.md §15,
 * SPEC.md §24.11).
 */
export const UsageProcess = z.object({
	pid: z.number().int().positive(),
	/** Null until a second sample exists. Percent of total CPU time. */
	cpuPercent: z.number().nonnegative().nullable(),
	/** Resident size, from VmRSS. */
	residentBytes: z.number().int().nonnegative(),
	command: z.string().min(1).max(15),
	/** Field 22 of `/proc/<pid>/stat`; with the pid it names one process. */
	startTicks: z.number().int().nonnegative(),
	/** False for a protected process: PID 1, another user's, the agent, tmux. */
	stoppable: z.boolean(),
	/** The student's own process's command line, NULs as spaces; else null. */
	commandLine: z.string().max(PROCESS_COMMAND_LINE_LIMIT).nullable(),
});
export type UsageProcess = z.infer<typeof UsageProcess>;

/** Used and total bytes of one mounted volume, from `statfs`. */
export const StorageFigure = z.object({
	usedBytes: z.number().int().nonnegative(),
	totalBytes: z.number().int().nonnegative(),
});
export type StorageFigure = z.infer<typeof StorageFigure>;

/**
 * One usage sample from the workspace agent (SPEC.md §18.2, §18.3).
 *
 * CPU percents and network rates need the previous sample, so they are null
 * the first time. The same process list answers the Monitor tab and the
 * selected Running row.
 */
export const WorkspaceUsage = z.object({
	observedAt: z.string().min(1),
	/** Null until a second sample exists. Share of total CPU time. */
	cpuPercent: z.number().nonnegative().nullable(),
	memory: z.object({
		usedBytes: z.number().int().nonnegative(),
		totalBytes: z.number().int().nonnegative(),
	}),
	/** The filesystem that holds the student's home. */
	disk: z.object({
		usedBytes: z.number().int().nonnegative(),
		totalBytes: z.number().int().nonnegative(),
	}),
	network: z.object({
		/** Bytes per second since the previous sample, loopback excluded. */
		receiveBytesPerSecond: z.number().nonnegative().nullable(),
		transmitBytesPerSecond: z.number().nonnegative().nullable(),
	}),
	processes: z.array(UsageProcess),
	/**
	 * The three storage classes (SPEC.md §18.3, §19.2). A class is null when
	 * its mount is missing.
	 */
	storage: z.object({
		home: StorageFigure.nullable(),
		docker: StorageFigure.nullable(),
		recovery: StorageFigure.nullable(),
	}),
});
export type WorkspaceUsage = z.infer<typeof WorkspaceUsage>;
