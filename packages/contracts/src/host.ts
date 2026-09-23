import { z } from "zod";
import { MAX_QUOTA_GIB } from "./admin.js";

const bytes = z.number().int().nonnegative();

/**
 * One look at the platform VM, taken by the controller for `GET /host`
 * (SPEC.md §19.2, §25.6). Aggregates only: no process list, no command
 * lines, nothing from inside a workspace (SPEC.md §20.2).
 */
export const HostSnapshot = z.object({
	observedAt: z.string().datetime(),
	/** 1, 5 and 15 minute load averages from `/proc/loadavg`. */
	loadAverage: z.tuple([
		z.number().nonnegative(),
		z.number().nonnegative(),
		z.number().nonnegative(),
	]),
	cpuCount: z.number().int().positive(),
	memory: z.object({ usedBytes: bytes, totalBytes: bytes }),
	pool: z.object({ name: z.string().min(1), usedBytes: bytes, totalBytes: bytes }),
	/** The shared workspace profile's limits, as Incus spells them. */
	profileLimits: z.object({
		cpu: z.string().nullable(),
		memory: z.string().nullable(),
		processes: z.string().nullable(),
	}),
	/** The image the `portikus` alias points to. */
	image: z.object({
		fingerprint: z.string().nullable(),
		serial: z.string().nullable(),
	}),
	instances: z.array(
		z.object({
			name: z.string().min(1),
			imageFingerprint: z.string().nullable(),
			/** `image.serial`; null on instances from images that lack it. */
			imageSerial: z.string().nullable(),
		}),
	),
});
export type HostSnapshot = z.infer<typeof HostSnapshot>;

/**
 * What the worker stores in `health_samples.sample` every 60 seconds. A row
 * is written even when the controller cannot be reached, so its age doubles
 * as the worker's heartbeat.
 */
export const HealthSample = z.object({
	controller: z.object({
		reachable: z.boolean(),
		errorCode: z.string().nullable(),
	}),
	host: HostSnapshot.nullable(),
});
export type HealthSample = z.infer<typeof HealthSample>;

const quotaGiB = z.number().int().positive().max(MAX_QUOTA_GIB);

/** Body of `POST /instances/:name/volumes` on the controller. Grow only. */
export const GrowVolumesRequest = z
	.object({ homeGiB: quotaGiB, dockerGiB: quotaGiB })
	.strict();
export type GrowVolumesRequest = z.infer<typeof GrowVolumesRequest>;

/** The sizes the volumes have after the request. */
export const GrowVolumesResponse = z.object({ homeGiB: quotaGiB, dockerGiB: quotaGiB });
export type GrowVolumesResponse = z.infer<typeof GrowVolumesResponse>;
