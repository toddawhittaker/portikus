import { z } from "zod";
import { PortNumber } from "./listening.js";
import {
	CpuThrottle,
	GuardThresholdPercent,
	GuardWindowMinutes,
	IdleStopMinutes,
	MemoryFlag,
	ThrottleSharePercent,
	Workspace,
} from "./workspace.js";

/** An account with no sign-in for this many days is marked stale (issue #302). */
export const STALE_AFTER_DAYS = 30;

/** Largest home or Docker volume an administrator may set, in GiB. */
export const MAX_QUOTA_GIB = 1024;

/** Newest-first audit rows per page (SPEC.md §24.11). */
export const AUDIT_PAGE_SIZE = 50;

/** What a quota change that shrinks a volume is told. */
export const QUOTA_SHRINK_MESSAGE = "Storage can only be increased.";

const quotaGiB = z.number().int().positive().max(MAX_QUOTA_GIB);
const bytes = z.number().int().nonnegative();

/** Home and Docker volume sizes in GiB. */
export const QuotaConfig = z.object({ homeGiB: quotaGiB, dockerGiB: quotaGiB });
export type QuotaConfig = z.infer<typeof QuotaConfig>;

/** Flags shown beside an account in the admin list (issue #302). */
export const AdminAccountMarkers = z.object({
	disabled: z.boolean(),
	archived: z.boolean(),
	duplicateEmail: z.boolean(),
	stale: z.boolean(),
	/** A course account retired by a link to an SSO account. */
	linked: z.boolean(),
});
export type AdminAccountMarkers = z.infer<typeof AdminAccountMarkers>;

/** The guard values one workspace runs with, after its overrides (ADR 0032). */
export const EffectiveGuard = z.object({
	cpuThresholdPercent: GuardThresholdPercent,
	memoryThresholdPercent: GuardThresholdPercent,
	windowMinutes: GuardWindowMinutes,
	throttleSharePercent: ThrottleSharePercent,
	idleStopMinutes: IdleStopMinutes,
});
export type EffectiveGuard = z.infer<typeof EffectiveGuard>;

/** `workspaces.guard_config`: any key present overrides the platform value. */
export const GuardConfig = EffectiveGuard.partial().strict();
export type GuardConfig = z.infer<typeof GuardConfig>;

/** Body of `PUT /admin/workspaces/:id/guard`: null removes that override. */
export const UpdateGuardRequest = z
	.object({
		cpuThresholdPercent: GuardThresholdPercent.nullable().optional(),
		memoryThresholdPercent: GuardThresholdPercent.nullable().optional(),
		windowMinutes: GuardWindowMinutes.nullable().optional(),
		throttleSharePercent: ThrottleSharePercent.nullable().optional(),
		idleStopMinutes: IdleStopMinutes.nullable().optional(),
	})
	.strict()
	.refine((body) => Object.values(body).some((value) => value !== undefined), {
		message: "At least one setting must be given",
	});
export type UpdateGuardRequest = z.infer<typeof UpdateGuardRequest>;

/** The readable image version of one instance, and whether it is current. */
export const AdminImageVersion = z.object({
	/** `image.serial`, or the first 12 characters of the fingerprint. */
	label: z.string().nullable(),
	fingerprint: z.string().nullable(),
	/** Null when no health sample says what the current image is. */
	current: z.boolean().nullable(),
});
export type AdminImageVersion = z.infer<typeof AdminImageVersion>;

/** One user's workspace, as a row of the admin list shows it (SPEC.md §20.1). */
export const AdminWorkspaceSummary = z.object({
	id: z.string().uuid(),
	label: z.string().min(1),
	/** A plain string so a state added later shows as its raw name. */
	state: z.string().min(1),
	desiredState: z.string().min(1),
	activeConnections: z.number().int().nonnegative(),
	lastActiveConnectionAt: z.string().datetime().nullable(),
	quotaConfig: QuotaConfig,
	/** The sizes the worker last applied; differs from quotaConfig while pending. */
	quotaApplied: QuotaConfig.nullable(),
	image: AdminImageVersion,
	archivedAt: z.string().datetime().nullable(),
	/** The Throttled and High memory tags (ADR 0032). */
	cpuThrottle: CpuThrottle.nullable(),
	memoryFlag: MemoryFlag.nullable(),
});
export type AdminWorkspaceSummary = z.infer<typeof AdminWorkspaceSummary>;

/** Whether Epic 10's rebuild and Reset Docker routes exist in this build. */
export const AdminCapabilities = z.object({
	rebuild: z.boolean(),
	resetDocker: z.boolean(),
});
export type AdminCapabilities = z.infer<typeof AdminCapabilities>;

const StorageUse = z.object({ usedBytes: bytes, limitBytes: bytes });

/** Per-class storage from Epic 10's accounting; null unless the agent measured all three. */
export const AdminStorage = z.object({
	home: StorageUse,
	docker: StorageUse,
	recovery: StorageUse,
});
export type AdminStorage = z.infer<typeof AdminStorage>;

/** One audit row with its actor resolved for display (SPEC.md §24.11). */
export const AuditEvent = z.object({
	id: z.number().int().positive(),
	at: z.string().datetime(),
	actor: z.string(),
	/** The actor's display name when the actor is a user, otherwise null. */
	actorName: z.string().nullable(),
	action: z.string(),
	target: z.string(),
	result: z.string(),
	metadata: z.record(z.string(), z.unknown()).nullable(),
});
export type AuditEvent = z.infer<typeof AuditEvent>;

/**
 * The detail panel for one workspace (SPEC.md §20.1). Aggregates and port
 * facts only; never command lines, process lists or tokens (SPEC.md §20.2).
 */
export const AdminWorkspaceDetail = z.object({
	workspace: Workspace,
	owner: z.object({
		id: z.string().uuid(),
		displayName: z.string().min(1),
		email: z.string().nullable(),
		preferredUsername: z.string().nullable(),
		disabledAt: z.string().datetime().nullable(),
	}),
	quotaApplied: QuotaConfig.nullable(),
	image: AdminImageVersion,
	/** "stopped" when the workspace is not running. */
	agent: z.enum(["answering", "not_answering", "stopped"]),
	/** Live usage while the agent answers, otherwise null. */
	usage: z
		.object({
			cpuPercent: z.number().nonnegative().nullable(),
			memory: z.object({ usedBytes: bytes, totalBytes: bytes }),
			disk: z.object({ usedBytes: bytes, totalBytes: bytes }),
		})
		.strict()
		.nullable(),
	storage: AdminStorage.nullable(),
	ports: z.array(
		z
			.object({
				port: PortNumber,
				/** The short process name, never the command line. */
				command: z.string().nullable(),
				previewReachability: z.enum(["reachable", "forwarded", "denied", "unknown"]),
				system: z.boolean(),
			})
			.strict(),
	),
	previewSessions: z.array(
		z.object({ port: PortNumber, openedAt: z.string().datetime() }).strict(),
	),
	recentAudit: z.array(AuditEvent),
	capabilities: AdminCapabilities,
	/** The resource guard section (ADR 0032); `workspace` carries the student's view. */
	guardConfig: GuardConfig.nullable(),
	effectiveGuard: EffectiveGuard,
	cpuThrottle: CpuThrottle.nullable(),
	memoryFlag: MemoryFlag.nullable(),
});
export type AdminWorkspaceDetail = z.infer<typeof AdminWorkspaceDetail>;

/** Body of `PUT /admin/workspaces/:id/quota`. */
export const UpdateQuotaRequest = QuotaConfig.strict();
export type UpdateQuotaRequest = z.infer<typeof UpdateQuotaRequest>;

/** True when no volume in `to` is smaller than in `from`. */
export function isQuotaGrowOnly(from: QuotaConfig, to: QuotaConfig): boolean {
	return to.homeGiB >= from.homeGiB && to.dockerGiB >= from.dockerGiB;
}

/** Query string of `GET /admin/audit`. */
export const AuditQuery = z
	.object({
		workspace: z.string().uuid().optional(),
		user: z.string().uuid().optional(),
		/** Matches actions that start with this, such as `workspace.`. */
		action: z.string().min(1).max(100).optional(),
		/** Keyset paging: return rows with an id below this. */
		before: z.coerce.number().int().positive().optional(),
	})
	.strict();
export type AuditQuery = z.infer<typeof AuditQuery>;

export const AuditPage = z.object({
	events: z.array(AuditEvent),
	/** Pass as `before` for the next page; null on the last page. */
	nextBefore: z.number().int().positive().nullable(),
});
export type AuditPage = z.infer<typeof AuditPage>;

/** Body of `GET /admin/health` (SPEC.md §25.6). */
export const HealthReport = z.object({
	/** When the newest sample was taken; null when there is none. */
	sampledAt: z.string().datetime().nullable(),
	/** True when the newest sample is older than 2 minutes, or missing. */
	workerStale: z.boolean(),
	controller: z.object({
		reachable: z.boolean(),
		errorCode: z.string().nullable(),
	}),
	host: z
		.object({
			loadAverage: z.tuple([z.number(), z.number(), z.number()]),
			cpuCount: z.number().int().positive(),
			memory: z.object({ usedBytes: bytes, totalBytes: bytes }),
			pool: z.object({
				usedBytes: bytes,
				totalBytes: bytes,
				/** Thin-pool metadata use; null when the host has not reported it. */
				metadataPercent: z.number().nonnegative().nullable(),
			}),
			profileLimits: z.object({
				cpu: z.string().nullable(),
				memory: z.string().nullable(),
				processes: z.string().nullable(),
			}),
			image: z.object({
				fingerprint: z.string().nullable(),
				serial: z.string().nullable(),
			}),
		})
		.nullable(),
	workspacesByState: z.record(z.string(), z.number().int().nonnegative()),
	agents: z.object({
		answering: z.number().int().nonnegative(),
		running: z.number().int().nonnegative(),
	}),
	last24h: z.object({
		startFailures: z.number().int().nonnegative(),
		stopFailures: z.number().int().nonnegative(),
		forcedStops: z.number().int().nonnegative(),
		provisionFailures: z.number().int().nonnegative(),
		controllerOutages: z.number().int().nonnegative(),
		signInFailures: z.number().int().nonnegative(),
		previewRefusals: z.number().int().nonnegative(),
	}),
	/** Up to 96 fifteen-minute maxima, oldest first. */
	series: z.array(
		z.object({
			at: z.string().datetime(),
			poolUsedBytes: bytes,
			poolTotalBytes: bytes,
			memoryUsedBytes: bytes,
			memoryTotalBytes: bytes,
			load1: z.number().nonnegative(),
		}),
	),
	/** Throttled or memory-flagged workspaces (ADR 0032). */
	guard: z.array(
		z.object({
			workspaceId: z.string().uuid(),
			owner: z.object({ id: z.string().uuid(), displayName: z.string().min(1) }),
			cpuThrottle: CpuThrottle.nullable(),
			memoryFlag: MemoryFlag.nullable(),
		}),
	),
});
export type HealthReport = z.infer<typeof HealthReport>;
