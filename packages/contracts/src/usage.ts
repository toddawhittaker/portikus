import { z } from "zod";

/**
 * One process inside the workspace (SPEC.md §18.2, §18.3).
 *
 * `command` is the short name from `/proc/<pid>/status`, not the command
 * line. Arguments can carry secrets, so the line is never read and this
 * name is never logged (STACK.md §15).
 */
export const UsageProcess = z.object({
	pid: z.number().int().positive(),
	/** Null until a second sample exists. Percent of total CPU time. */
	cpuPercent: z.number().nonnegative().nullable(),
	/** Resident size, from VmRSS. */
	residentBytes: z.number().int().nonnegative(),
	command: z.string().min(1).max(15),
});
export type UsageProcess = z.infer<typeof UsageProcess>;

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
});
export type WorkspaceUsage = z.infer<typeof WorkspaceUsage>;
