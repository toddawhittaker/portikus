import { z } from "zod";
import { InstanceProcess, LimitCpu, LimitMemoryMiB, LimitProcesses } from "./admin.js";
import { WorkspaceDockerConfig } from "./docker-cache.js";
import { Timezone } from "./settings.js";

/**
 * The instance create's operation wait. The worker's create budget is this
 * plus a margin; a retry adopts whatever already exists.
 */
export const INSTANCE_CREATE_WAIT_SECONDS = 240;

/** A volume create on a busy thin pool can pass the default 30 s, so each gets 60 s. */
export const VOLUME_CREATE_TIMEOUT_MS = 60_000;

/**
 * The caller's remaining time budget in milliseconds, sent on every controller
 * call so the controller stops work nobody will wait for (ADR 0034).
 */
export const CONTROLLER_BUDGET_HEADER = "x-portikus-budget-ms";

/**
 * The worker's budget for an instance create: the instance wait, three volume
 * creates (home, Docker, recovery), and a 60 s margin. The controller also uses
 * it when a create request carries no budget header (ADR 0034).
 */
export const INSTANCE_CREATE_BUDGET_MS =
	INSTANCE_CREATE_WAIT_SECONDS * 1000 + 3 * VOLUME_CREATE_TIMEOUT_MS + 60_000;

/** How long one agent restart after an upgrade may take. */
export const AGENT_RESTART_TIMEOUT_SECONDS = 60;

/** How long the controller waits for the egress helper to answer. */
export const EGRESS_HELPER_TIMEOUT_MS = 30_000;

/**
 * Incus instance name (SPEC.md §6, §18.3; STACK.md §5, §9). The provider
 * checks it again for defence in depth.
 */
export const InstanceName = z
	.string()
	.regex(
		/^[a-z][a-z0-9-]{0,30}$/,
		"Must start with a lowercase letter and contain only lowercase letters, digits, or hyphens (max 31 chars)",
	);
export type InstanceName = z.infer<typeof InstanceName>;

/** Request body for `POST /instances` on the controller (SPEC.md §26, §27). */
export const CreateInstanceRequest = z.object({
	name: InstanceName,
	homeGiB: z.number().int().positive(),
	dockerGiB: z.number().int().positive(),
	recoveryGiB: z.number().int().positive(),
});
export type CreateInstanceRequest = z.infer<typeof CreateInstanceRequest>;

/** Response body for `POST /instances` (SPEC.md §26, §27). */
export const CreateInstanceResponse = z.object({
	created: z.boolean(),
	imageFingerprint: z.string().min(1),
	quota: z.object({
		homeGiB: z.number().int().positive(),
		dockerGiB: z.number().int().positive(),
	}),
});
export type CreateInstanceResponse = z.infer<typeof CreateInstanceResponse>;

/**
 * A hard CPU cap as a time slice, such as `100ms/100ms` for one CPU's worth.
 * Never a percentage, which Incus treats as a soft share (ADR 0032).
 */
export const CpuAllowance = z
	.string()
	.regex(/^\d{1,6}ms\/100ms$/, "Must be a time slice such as 100ms/100ms")
	.refine((value) => Number.parseInt(value, 10) > 0, {
		message: "Must be more than 0ms",
	});
export type CpuAllowance = z.infer<typeof CpuAllowance>;

/** Request body for `POST /instances/:name/start` (SPEC.md §26, §27). */
export const StartInstanceRequest = z.object({
	timeoutSeconds: z.number().int().positive().default(60),
	// Per-workspace agent token, pushed into the container as a file so the
	// API can authenticate to the agent (SPEC.md §23.5).
	agentToken: z.string().regex(/^[0-9a-f]{64}$/, "Must be 64 hex characters"),
	// The workspace label, set as the container hostname at every start so
	// the shell prompt reads `student@<label>` (SPEC.md section 14.3).
	hostname: z
		.string()
		.regex(
			/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/,
			"Must be a lowercase DNS label with no leading or trailing hyphen",
		)
		.max(40),
	// The preview host suffix, pushed into the container on every start so
	// shells and dev servers can name the preview host
	// (BROWSER-HANDLING.md section 14). Never carries a credential.
	previewHostSuffix: z
		.string()
		.regex(
			/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/,
			"Must be a lowercase DNS name",
		)
		.max(253),
	// The owner's timezone, set on the container at every start so shells,
	// logs, and Git commits read in the student's own clock.
	timezone: Timezone,
	// Size of the Docker volume to put back when a failed Reset Docker left
	// it off (ADR 0021). When absent the controller skips that step.
	dockerGiB: z.number().int().positive().optional(),
	// Size of the recovery volume to add when it is missing (ADR 0020).
	// When absent the controller skips that step.
	recoveryGiB: z.number().int().positive().optional(),
	// A held throttle's allowance, set before the instance runs so a restart
	// never gives it a moment at full speed. When absent any allowance is removed.
	cpuAllowance: CpuAllowance.optional(),
	// Registry cache and ghcr settings written into the workspace before it
	// runs. When absent the controller leaves Docker's config alone.
	docker: WorkspaceDockerConfig.optional(),
});
export type StartInstanceRequest = z.infer<typeof StartInstanceRequest>;

/** Response body for `POST /instances/:name/start` (SPEC.md §26, §27). */
export const StartInstanceResponse = z.object({
	ipv4: z.string().min(1),
});
export type StartInstanceResponse = z.infer<typeof StartInstanceResponse>;

/** Request body for `POST /instances/:name/stop` (SPEC.md §26, §27). */
export const StopInstanceRequest = z.object({
	timeoutSeconds: z.number().int().positive(),
});
export type StopInstanceRequest = z.infer<typeof StopInstanceRequest>;

/** Response body for `POST /instances/:name/stop` (SPEC.md §26, §27). */
export const StopInstanceResponse = z.object({
	forced: z.boolean(),
});
export type StopInstanceResponse = z.infer<typeof StopInstanceResponse>;

/**
 * Request body for `POST /instances/:name/reset-docker`: replace the
 * Docker volume with a clean one of this size (SPEC.md §16.4, ADR 0021).
 */
export const ResetDockerRequest = z.object({
	dockerGiB: z.number().int().positive(),
});
export type ResetDockerRequest = z.infer<typeof ResetDockerRequest>;

/**
 * Request body for `POST /instances/:name/rebuild`: replace the root
 * filesystem from the current image, optionally with a clean Docker volume
 * (SPEC.md §17.2, §22.3, ADR 0021).
 */
export const RebuildInstanceRequest = z.object({
	resetDocker: z.boolean(),
	dockerGiB: z.number().int().positive(),
});
export type RebuildInstanceRequest = z.infer<typeof RebuildInstanceRequest>;

/** Response body for `POST /instances/:name/rebuild`. */
export const RebuildInstanceResponse = z.object({
	imageFingerprint: z.string().min(1),
});
export type RebuildInstanceResponse = z.infer<typeof RebuildInstanceResponse>;

/**
 * Status of a single Incus instance as returned by the controller
 * (SPEC.md §18.3, §26).
 */
export const InstanceStatusEnum = z.enum(["Running", "Stopped", "Other"]);
export type InstanceStatusEnum = z.infer<typeof InstanceStatusEnum>;

export const InstanceStatus = z.object({
	name: z.string().min(1),
	status: InstanceStatusEnum,
	ipv4: z.string().nullable(),
});
export type InstanceStatus = z.infer<typeof InstanceStatus>;

/** Response body for `GET /instances` (SPEC.md §26). */
export const ListInstancesResponse = z.array(InstanceStatus);
export type ListInstancesResponse = z.infer<typeof ListInstancesResponse>;

/**
 * One running instance's CPU time and memory from Incus, for the resource
 * guard (ADR 0032). Totals only: no process, command line or file name.
 */
export const InstanceUsage = z.object({
	name: z.string().min(1),
	/** CPU time in nanoseconds since the instance started. */
	// Not .int(): a counter above 2^53 is a valid, if imprecise, number.
	cpuUsageNs: z.number().nonnegative(),
	/**
	 * Changes on every boot, including a reboot from inside the workspace:
	 * the host PID of the instance's init. Null when Incus does not report it.
	 */
	bootMarker: z.number().int().positive().nullable(),
	/** `limits.cpu` as a count, or the host's CPU count when unset. */
	cpuLimit: z.number().int().positive(),
	/** The working set: usage without reclaimable file cache. */
	memoryBytes: z.number().int().nonnegative(),
	memoryLimitBytes: z.number().int().positive(),
	/** The current `limits.cpu.allowance` as Incus holds it, or null. */
	cpuAllowance: z.string().nullable(),
});
export type InstanceUsage = z.infer<typeof InstanceUsage>;

/** Response body for `GET /instances/usage`. */
export const InstanceUsageResponse = z.object({ instances: z.array(InstanceUsage) });
export type InstanceUsageResponse = z.infer<typeof InstanceUsageResponse>;

/** Response body for `GET /instances/:name/processes`: at most 20 rows. */
export const InstanceProcessesResponse = z.object({
	processes: z.array(InstanceProcess).max(20),
});
export type InstanceProcessesResponse = z.infer<typeof InstanceProcessesResponse>;

/** Request body for `PUT /instances/:name/cpu-allowance`; null removes it. */
export const SetCpuAllowanceRequest = z
	.object({ allowance: CpuAllowance.nullable() })
	.strict();
export type SetCpuAllowanceRequest = z.infer<typeof SetCpuAllowanceRequest>;

/**
 * Request body for `PUT /instances/:name/limits`: per-workspace limits set on
 * the instance, never the profile. Null removes the instance's own key so the
 * profile's value applies again (SPEC.md §19.3).
 */
export const SetInstanceLimitsRequest = z
	.object({
		cpu: LimitCpu.nullable(),
		memoryMiB: LimitMemoryMiB.nullable(),
		processes: LimitProcesses.nullable(),
	})
	.strict();
export type SetInstanceLimitsRequest = z.infer<typeof SetInstanceLimitsRequest>;

/** A Debian package name, as policy section 5.6.1 allows it. */
export const DebianPackageName = z.string().regex(/^[a-z0-9][a-z0-9+.-]{1,99}$/);
export type DebianPackageName = z.infer<typeof DebianPackageName>;

/**
 * Response body for `GET /instances/:name/added-packages`: the packages the
 * student added with apt, from the list the image's apt hook writes. `image`
 * is the image version named in its header, or null when there is none.
 * A workspace with no list yet gets a null image and no packages.
 */
export const AddedPackagesResponse = z.object({
	image: z.string().nullable(),
	packages: z.array(DebianPackageName),
});
export type AddedPackagesResponse = z.infer<typeof AddedPackagesResponse>;

/** A workspace's own custom volume, the only kind a snapshot is deleted from. */
export const WorkspaceVolumeName = z
	.string()
	.regex(/^ws-[0-9a-f]{24}-(home|docker|recovery)$/, "Must be a workspace volume");

/** A pre-change snapshot; the backup's own `portikus-backup` never matches. */
export const PreChangeSnapshotName = z
	.string()
	.regex(/^pre-[a-z0-9][a-z0-9-]{0,62}$/, "Must be a pre-change snapshot");

/** A home kept by Replace home, the only volume the controller deletes by name. */
export const KeptHomeVolumeName = z
	.string()
	.regex(/^ws-[0-9a-f]{24}-home-replaced-[0-9]{1,20}$/, "Must be a kept home");

/** Response body for `GET /volumes/kept`. */
export const KeptVolumesResponse = z.object({
	snapshots: z.array(
		z.object({ volume: z.string(), name: z.string(), createdAt: z.string() }),
	),
	keptHomes: z.array(
		z.object({ volume: z.string(), instance: z.string(), createdAt: z.string() }),
	),
});
export type KeptVolumesResponse = z.infer<typeof KeptVolumesResponse>;

/** Response body for `POST /instances/:name/replace-home`: the kept home's volume. */
export const ReplaceHomeResponse = z.object({ kept: z.string().min(1) });
export type ReplaceHomeResponse = z.infer<typeof ReplaceHomeResponse>;

/**
 * Error codes returned by the workspace controller (SPEC.md §27;
 * STACK.md §9).
 */
export const ControllerErrorCode = z.enum([
	"BAD_REQUEST",
	"INVALID_NAME",
	"NOT_FOUND",
	"ALREADY_EXISTS",
	"IMAGE_NOT_FOUND",
	"STORAGE_FULL",
	// The shared storage pool is too full for a new workspace (SPEC.md §20.1).
	"POOL_FULL",
	"OPERATION_FAILED",
	"TIMEOUT",
	"INCUS_UNAVAILABLE",
	"UNAUTHORIZED",
]);
export type ControllerErrorCode = z.infer<typeof ControllerErrorCode>;

/** Standard error response from the workspace controller (SPEC.md §27). */
export const ControllerError = z.object({
	code: ControllerErrorCode,
	message: z.string(),
});
export type ControllerError = z.infer<typeof ControllerError>;
