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

/**
 * The IANA zone names this build knows (issue #287). This is the server's
 * list: a browser's own list can differ, so the browser is handed this one by
 * `GET /me/settings` instead of building its own. It is both the whole list
 * the student chooses from and the only list a zone name is accepted from, so
 * a name that reaches a command inside the container is always one of these.
 */
export function systemTimezones(): readonly string[] {
	return Intl.supportedValuesOf("timeZone");
}

/** Built on first use, so a browser bundle never pays for it. */
let systemTimezoneSet: Set<string> | null = null;

/** Whether a value is one of the zone names this build knows. */
export function isSystemTimezone(value: unknown): value is string {
	systemTimezoneSet ??= new Set(systemTimezones());
	return typeof value === "string" && systemTimezoneSet.has(value);
}

/** The zone a workspace runs in until the student picks another (issue #287). */
export const DEFAULT_TIMEZONE = "America/New_York";

/**
 * A zone name, checked against the list of the process doing the checking.
 * Parsed on the server only: the API, the worker, the controller and the
 * workspace agent are one build, so they all accept the same names.
 */
export const Timezone = z.string().refine(isSystemTimezone, {
	message: "Must be an IANA time zone name such as America/New_York",
});
export type Timezone = z.infer<typeof Timezone>;

export const EditorSettings = z.object({
	autoSave: z.boolean(),
	autoSaveDelaySeconds: z.number().int().min(1).max(60),
	wordWrap: z.boolean(),
	terminalTheme: TerminalTheme,
	/**
	 * The IANA zone the student's workspace runs in (issue #287). A plain
	 * string here because the browser parses this schema too and knows a
	 * different set of zone names; the server checks the value against its
	 * own list whenever one is written.
	 */
	timezone: z.string().min(1),
});
export type EditorSettings = z.infer<typeof EditorSettings>;

/** The values a user gets before they change anything. */
export const EDITOR_SETTINGS_DEFAULTS: EditorSettings = {
	autoSave: true,
	autoSaveDelaySeconds: 5,
	wordWrap: true,
	terminalTheme: "dark",
	timezone: DEFAULT_TIMEZONE,
};

/**
 * Request body for `PUT /me/settings`. Every field is optional and is merged
 * into the stored settings; a request that changes nothing is rejected. The
 * zone is checked against the server's list, which is the same list the API
 * hands the browser, so the dialog can only offer names this accepts.
 */
export const UpdateEditorSettingsRequest = EditorSettings.extend({
	timezone: Timezone,
})
	.partial()
	.strict()
	.refine((body) => Object.values(body).some((value) => value !== undefined), {
		message: "At least one setting must be given",
	});
export type UpdateEditorSettingsRequest = z.infer<typeof UpdateEditorSettingsRequest>;

/**
 * The body of `GET /me/settings`: the settings plus every zone name the
 * server will accept, so the dialog offers exactly what the API takes
 * (issue #287).
 */
export const MeSettings = EditorSettings.extend({
	timezones: z.array(z.string()),
});
export type MeSettings = z.infer<typeof MeSettings>;
