import { z } from "zod";
import { Role } from "./auth.js";

/** Largest value a PostgreSQL integer column holds. */
const MAX_GRACE_SECONDS = 2147483647;

const graceSeconds = z.number().int().min(0).max(MAX_GRACE_SECONDS);

/** The log levels Portikus uses, loudest first (STACK.md §15). */
export const LOG_LEVELS = ["error", "warn", "info", "debug"] as const;

/** How much a service logs (STACK.md §15). */
export const LogLevel = z.enum(LOG_LEVELS);
export type LogLevel = z.infer<typeof LogLevel>;

/**
 * Platform-wide settings an administrator can change while the system runs
 * (SPEC.md §6.4). A grace period of 0 means a disconnected workspace keeps
 * running indefinitely. A null log level means each service uses its own
 * LOG_LEVEL from the environment.
 */
export const PlatformSettings = z.object({
	shutdownGraceSeconds: graceSeconds,
	logLevel: LogLevel.nullable(),
	updatedAt: z.string().datetime().nullable(),
});
export type PlatformSettings = z.infer<typeof PlatformSettings>;

/**
 * Request body for changing the platform-wide settings. Every field is
 * optional, but a request that changes nothing is rejected.
 */
export const UpdatePlatformSettingsRequest = z
	.object({
		shutdownGraceSeconds: graceSeconds.optional(),
		logLevel: LogLevel.nullable().optional(),
	})
	.strict()
	.refine(
		(body) => body.shutdownGraceSeconds !== undefined || body.logLevel !== undefined,
		{ message: "At least one setting must be given" },
	);
export type UpdatePlatformSettingsRequest = z.infer<
	typeof UpdatePlatformSettingsRequest
>;

/**
 * Request body of `PUT /log-level` on the agent and the controller. Null
 * means "go back to the level in this service's own environment".
 */
export const SetLogLevelRequest = z.object({ level: LogLevel.nullable() }).strict();
export type SetLogLevelRequest = z.infer<typeof SetLogLevelRequest>;

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

/**
 * One user's editor and terminal preferences (issues #159 and #239). Every
 * field has a default, so a user who has never changed anything still gets a
 * complete object.
 */
export const TERMINAL_THEMES = ["dark", "light"] as const;

/** The colour scheme a student's terminals use (issue #239). */
export const TerminalTheme = z.enum(TERMINAL_THEMES);
export type TerminalTheme = z.infer<typeof TerminalTheme>;

export const EditorSettings = z.object({
	autoSave: z.boolean(),
	autoSaveDelaySeconds: z.number().int().min(1).max(60),
	wordWrap: z.boolean(),
	terminalTheme: TerminalTheme,
});
export type EditorSettings = z.infer<typeof EditorSettings>;

/** The values a user gets before they change anything. */
export const EDITOR_SETTINGS_DEFAULTS: EditorSettings = {
	autoSave: true,
	autoSaveDelaySeconds: 5,
	wordWrap: true,
	terminalTheme: "dark",
};

/**
 * Request body for `PUT /me/settings`. Every field is optional and is merged
 * into the stored settings; a request that changes nothing is rejected.
 */
export const UpdateEditorSettingsRequest = EditorSettings.partial()
	.strict()
	.refine((body) => Object.values(body).some((value) => value !== undefined), {
		message: "At least one setting must be given",
	});
export type UpdateEditorSettingsRequest = z.infer<typeof UpdateEditorSettingsRequest>;
