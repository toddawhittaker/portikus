import { z } from "zod";
import { Timezone } from "./settings.js";

/**
 * Validated Incus instance name (SPEC.md §6, §18.3; STACK.md §5, §9).
 *
 * Must start with a lowercase letter, followed by up to 30 lowercase
 * alphanumeric characters or hyphens. This is validated at the contract
 * boundary and again inside the provider for defence in depth.
 */
export const InstanceName = z
	.string()
	.regex(
		/^[a-z][a-z0-9-]{0,30}$/,
		"Must start with a lowercase letter and contain only lowercase letters, digits, or hyphens (max 31 chars)",
	);
export type InstanceName = z.infer<typeof InstanceName>;

/**
 * Request body for `POST /instances` on the controller (SPEC.md §26, §27).
 */
export const CreateInstanceRequest = z.object({
	name: InstanceName,
	homeGiB: z.number().int().positive(),
	dockerGiB: z.number().int().positive(),
	recoveryGiB: z.number().int().positive(),
});
export type CreateInstanceRequest = z.infer<typeof CreateInstanceRequest>;

/**
 * Response body for `POST /instances` (SPEC.md §26, §27).
 */
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
 * Request body for `POST /instances/:name/start` (SPEC.md §26, §27).
 */
export const StartInstanceRequest = z.object({
	timeoutSeconds: z.number().int().positive().default(60),
	// Per-workspace agent token, pushed into the container as a file so the
	// API can authenticate to the agent (SPEC.md §23.5).
	agentToken: z.string().regex(/^[0-9a-f]{64}$/, "Must be 64 hex characters"),
	// The workspace label, set as the container hostname at every start so
	// the shell prompt reads `student@<label>` (SPEC.md Epic 8).
	hostname: z
		.string()
		.regex(
			/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/,
			"Must be a lowercase DNS label with no leading or trailing hyphen",
		)
		.max(40),
	// The preview host suffix, pushed into the container on every start so
	// shells and dev servers can name the preview host (issue #263,
	// BROWSER-HANDLING.md section 14). Never carries a credential.
	previewHostSuffix: z
		.string()
		.regex(
			/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/,
			"Must be a lowercase DNS name",
		)
		.max(253),
	// The owner's timezone, set on the container at every start so shells,
	// logs, and Git commits read in the student's own clock (issue #287).
	timezone: Timezone,
	// Size of the recovery volume to add when it is missing (ADR 0020).
	// When absent the controller skips that step.
	recoveryGiB: z.number().int().positive().optional(),
});
export type StartInstanceRequest = z.infer<typeof StartInstanceRequest>;

/**
 * Response body for `POST /instances/:name/start` (SPEC.md §26, §27).
 */
export const StartInstanceResponse = z.object({
	ipv4: z.string().min(1),
});
export type StartInstanceResponse = z.infer<typeof StartInstanceResponse>;

/**
 * Request body for `POST /instances/:name/stop` (SPEC.md §26, §27).
 */
export const StopInstanceRequest = z.object({
	timeoutSeconds: z.number().int().positive(),
});
export type StopInstanceRequest = z.infer<typeof StopInstanceRequest>;

/**
 * Response body for `POST /instances/:name/stop` (SPEC.md §26, §27).
 */
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

/**
 * Response body for `GET /instances` (SPEC.md §26).
 */
export const ListInstancesResponse = z.array(InstanceStatus);
export type ListInstancesResponse = z.infer<typeof ListInstancesResponse>;

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
	"OPERATION_FAILED",
	"TIMEOUT",
	"INCUS_UNAVAILABLE",
	"UNAUTHORIZED",
]);
export type ControllerErrorCode = z.infer<typeof ControllerErrorCode>;

/**
 * Standard error response from the workspace controller (SPEC.md §27).
 */
export const ControllerError = z.object({
	code: ControllerErrorCode,
	message: z.string(),
});
export type ControllerError = z.infer<typeof ControllerError>;
