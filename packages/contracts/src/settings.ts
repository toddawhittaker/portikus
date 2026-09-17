import { z } from "zod";
import { Role } from "./auth.js";

/** Largest value a PostgreSQL integer column holds. */
const MAX_GRACE_SECONDS = 2147483647;

const graceSeconds = z.number().int().min(0).max(MAX_GRACE_SECONDS);

/**
 * Platform-wide settings an administrator can change while the system runs
 * (SPEC.md §6.4). A grace period of 0 means a disconnected workspace keeps
 * running indefinitely.
 */
export const PlatformSettings = z.object({
	shutdownGraceSeconds: graceSeconds,
	updatedAt: z.string().datetime().nullable(),
});
export type PlatformSettings = z.infer<typeof PlatformSettings>;

/** Request body for changing the platform-wide grace period. */
export const UpdatePlatformSettingsRequest = z
	.object({
		shutdownGraceSeconds: graceSeconds,
	})
	.strict();
export type UpdatePlatformSettingsRequest = z.infer<
	typeof UpdatePlatformSettingsRequest
>;

/** A user as the administration pages list them (SPEC.md §5.2). */
export const AdminUser = z.object({
	id: z.string().uuid(),
	displayName: z.string().min(1),
	email: z.string().nullable(),
	role: Role,
	disabledAt: z.string().datetime().nullable(),
	/** Per-user override; null means use the platform-wide value. */
	shutdownGraceSeconds: graceSeconds.nullable(),
});
export type AdminUser = z.infer<typeof AdminUser>;

export const AdminUserList = z.object({
	users: z.array(AdminUser),
});
export type AdminUserList = z.infer<typeof AdminUserList>;

/** Request body for setting or clearing one user's grace period override. */
export const UpdateAdminUserSettingsRequest = z
	.object({
		shutdownGraceSeconds: graceSeconds.nullable(),
	})
	.strict();
export type UpdateAdminUserSettingsRequest = z.infer<
	typeof UpdateAdminUserSettingsRequest
>;
