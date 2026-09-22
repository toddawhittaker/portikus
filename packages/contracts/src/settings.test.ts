import { expect, test } from "vitest";
import {
	AdminUser,
	AdminUserList,
	DEFAULT_TIMEZONE,
	EDITOR_SETTINGS_DEFAULTS,
	EditorSettings,
	githubHref,
	MeSettings,
	PlatformSettings,
	SetLogLevelRequest,
	systemTimezones,
	UpdateAdminUserSettingsRequest,
	UpdateEditorSettingsRequest,
	UpdatePlatformSettingsRequest,
	UpdateProfileRequest,
} from "./index.js";

test("PlatformSettings accepts zero, meaning no shutdown", () => {
	const parsed = PlatformSettings.parse({
		shutdownGraceSeconds: 0,
		logLevel: null,
		updatedAt: null,
	});
	expect(parsed.shutdownGraceSeconds).toBe(0);
	expect(parsed.logLevel).toBeNull();
});

test("PlatformSettings accepts an ISO timestamp", () => {
	const parsed = PlatformSettings.parse({
		shutdownGraceSeconds: 600,
		logLevel: "debug",
		updatedAt: "2026-09-17T10:00:00.000Z",
	});
	expect(parsed.updatedAt).toBe("2026-09-17T10:00:00.000Z");
});

test("PlatformSettings rejects a non-ISO timestamp", () => {
	expect(() =>
		PlatformSettings.parse({
			shutdownGraceSeconds: 600,
			logLevel: null,
			updatedAt: "yesterday",
		}),
	).toThrow();
});

test("PlatformSettings rejects a log level we do not have", () => {
	expect(() =>
		PlatformSettings.parse({
			shutdownGraceSeconds: 600,
			logLevel: "verbose",
			updatedAt: null,
		}),
	).toThrow();
});

test("UpdatePlatformSettingsRequest takes either field on its own or both", () => {
	expect(
		UpdatePlatformSettingsRequest.parse({ shutdownGraceSeconds: 600 }).logLevel,
	).toBeUndefined();
	expect(UpdatePlatformSettingsRequest.parse({ logLevel: "debug" }).logLevel).toBe(
		"debug",
	);
	expect(UpdatePlatformSettingsRequest.parse({ logLevel: null }).logLevel).toBeNull();
	const both = UpdatePlatformSettingsRequest.parse({
		shutdownGraceSeconds: 60,
		logLevel: "warn",
	});
	expect(both.shutdownGraceSeconds).toBe(60);
	expect(both.logLevel).toBe("warn");
});

test("UpdatePlatformSettingsRequest rejects a body that changes nothing", () => {
	expect(() => UpdatePlatformSettingsRequest.parse({})).toThrow();
});

test("SetLogLevelRequest takes one known level or null, and nothing else", () => {
	expect(SetLogLevelRequest.parse({ level: "error" }).level).toBe("error");
	expect(() => SetLogLevelRequest.parse({ level: "verbose" })).toThrow();
	expect(SetLogLevelRequest.parse({ level: null }).level).toBeNull();
	expect(() => SetLogLevelRequest.parse({ level: "info", extra: 1 })).toThrow();
});

test("UpdatePlatformSettingsRequest rejects negatives, fractions and strings", () => {
	expect(() =>
		UpdatePlatformSettingsRequest.parse({ shutdownGraceSeconds: -1 }),
	).toThrow();
	expect(() =>
		UpdatePlatformSettingsRequest.parse({ shutdownGraceSeconds: 1.5 }),
	).toThrow();
	expect(() =>
		UpdatePlatformSettingsRequest.parse({ shutdownGraceSeconds: "600" }),
	).toThrow();
});

test("UpdatePlatformSettingsRequest rejects a value past the integer column limit", () => {
	expect(() =>
		UpdatePlatformSettingsRequest.parse({ shutdownGraceSeconds: 2147483648 }),
	).toThrow();
	expect(
		UpdatePlatformSettingsRequest.parse({ shutdownGraceSeconds: 2147483647 })
			.shutdownGraceSeconds,
	).toBe(2147483647);
});

test("UpdatePlatformSettingsRequest rejects unknown keys", () => {
	expect(() =>
		UpdatePlatformSettingsRequest.parse({ shutdownGraceSeconds: 600, extra: 1 }),
	).toThrow();
});

const sampleAdminUser = {
	id: "11111111-2222-4333-8444-555555555555",
	displayName: "Ada Lovelace",
	email: "ada@example.edu",
	role: "student",
	disabledAt: null,
	shutdownGraceSeconds: null,
};

test("AdminUser accepts a null email, null override and a null disabledAt", () => {
	const parsed = AdminUser.parse({ ...sampleAdminUser, email: null });
	expect(parsed.email).toBeNull();
	expect(parsed.shutdownGraceSeconds).toBeNull();
});

test("AdminUser accepts an override of zero", () => {
	expect(
		AdminUser.parse({ ...sampleAdminUser, shutdownGraceSeconds: 0 })
			.shutdownGraceSeconds,
	).toBe(0);
});

test("AdminUser rejects a bad id, a bad role and a negative override", () => {
	expect(() => AdminUser.parse({ ...sampleAdminUser, id: "not-a-uuid" })).toThrow();
	expect(() => AdminUser.parse({ ...sampleAdminUser, role: "teacher" })).toThrow();
	expect(() =>
		AdminUser.parse({ ...sampleAdminUser, shutdownGraceSeconds: -1 }),
	).toThrow();
});

test("AdminUserList parses a list of users", () => {
	const parsed = AdminUserList.parse({ users: [sampleAdminUser] });
	expect(parsed.users).toHaveLength(1);
});

test("UpdateAdminUserSettingsRequest accepts null to clear the override", () => {
	expect(
		UpdateAdminUserSettingsRequest.parse({ shutdownGraceSeconds: null })
			.shutdownGraceSeconds,
	).toBeNull();
});

test("UpdateAdminUserSettingsRequest rejects bad values and unknown keys", () => {
	expect(() =>
		UpdateAdminUserSettingsRequest.parse({ shutdownGraceSeconds: -1 }),
	).toThrow();
	expect(() =>
		UpdateAdminUserSettingsRequest.parse({ shutdownGraceSeconds: 1.5 }),
	).toThrow();
	expect(() =>
		UpdateAdminUserSettingsRequest.parse({ shutdownGraceSeconds: "600" }),
	).toThrow();
	expect(() =>
		UpdateAdminUserSettingsRequest.parse({ shutdownGraceSeconds: 600, extra: 1 }),
	).toThrow();
});

test("the editor settings defaults are a valid, complete set", () => {
	expect(EditorSettings.parse(EDITOR_SETTINGS_DEFAULTS)).toEqual({
		autoSave: true,
		autoSaveDelaySeconds: 5,
		// Issue #270: wrap is on unless the student turns it off.
		wordWrap: true,
		terminalTheme: "dark",
		timezone: "America/New_York",
		appearance: "system",
	});
});

/** Issue #239: the terminal is dark unless the student asks for light. */
test("EditorSettings takes only the two terminal themes", () => {
	expect(
		EditorSettings.parse({ ...EDITOR_SETTINGS_DEFAULTS, terminalTheme: "light" })
			.terminalTheme,
	).toBe("light");
	expect(() =>
		EditorSettings.parse({ ...EDITOR_SETTINGS_DEFAULTS, terminalTheme: "solarized" }),
	).toThrow();
});

test("EditorSettings keeps the auto-save delay between 1 and 60 seconds", () => {
	expect(
		EditorSettings.parse({ ...EDITOR_SETTINGS_DEFAULTS, autoSaveDelaySeconds: 60 })
			.autoSaveDelaySeconds,
	).toBe(60);
	for (const bad of [0, 61, 5.5, "5"]) {
		expect(() =>
			EditorSettings.parse({ ...EDITOR_SETTINGS_DEFAULTS, autoSaveDelaySeconds: bad }),
		).toThrow();
	}
});

test("EditorSettings requires every field", () => {
	expect(() => EditorSettings.parse({ autoSave: true })).toThrow();
});

/**
 * Issue #287: the workspace runs in a zone the student may change. Only a
 * write is checked against the zone list, because a browser reading this
 * schema back knows a different set of names.
 */
test("a zone is only checked when one is written", () => {
	expect(EDITOR_SETTINGS_DEFAULTS.timezone).toBe(DEFAULT_TIMEZONE);
	expect(UpdateEditorSettingsRequest.parse({ timezone: "Europe/Berlin" })).toEqual({
		timezone: "Europe/Berlin",
	});
	for (const bad of ["Mars/Olympus", "", "America/New_York; rm -rf /", 5]) {
		expect(() => UpdateEditorSettingsRequest.parse({ timezone: bad })).toThrow();
	}
	// Reading is lenient, so a zone this build dropped still comes back.
	expect(
		EditorSettings.parse({ ...EDITOR_SETTINGS_DEFAULTS, timezone: "Mars/Olympus" })
			.timezone,
	).toBe("Mars/Olympus");
});

/** Issue #287: the browser is given the server's list, not asked for its own. */
test("MeSettings carries the zone list beside the settings", () => {
	const zones = [...systemTimezones()];
	expect(MeSettings.parse({ ...EDITOR_SETTINGS_DEFAULTS, timezones: zones })).toEqual({
		...EDITOR_SETTINGS_DEFAULTS,
		timezones: zones,
	});
	expect(() => MeSettings.parse(EDITOR_SETTINGS_DEFAULTS)).toThrow();
});

/**
 * Issue #287: the zone name reaches a command inside the container, so
 * nothing on this list may carry a shell metacharacter.
 */
test("the zone list holds the default and no shell metacharacters", () => {
	expect(systemTimezones()).toContain(DEFAULT_TIMEZONE);
	for (const zone of systemTimezones()) {
		expect(zone).toMatch(/^[A-Za-z0-9_+\-/]+$/);
	}
});

test("UpdateEditorSettingsRequest takes one field at a time", () => {
	expect(UpdateEditorSettingsRequest.parse({ wordWrap: true })).toEqual({
		wordWrap: true,
	});
});

test("UpdateEditorSettingsRequest rejects an empty body and unknown keys", () => {
	expect(() => UpdateEditorSettingsRequest.parse({})).toThrow();
	expect(() => UpdateEditorSettingsRequest.parse({ theme: "dark" })).toThrow();
	expect(() => UpdateEditorSettingsRequest.parse({ autoSave: "yes" })).toThrow();
});

/** Issue #300: appearance is a per-user setting that starts on "system". */
test("appearance defaults to system and takes only the three choices", () => {
	expect(EDITOR_SETTINGS_DEFAULTS.appearance).toBe("system");
	expect(UpdateEditorSettingsRequest.safeParse({ appearance: "dark" }).success).toBe(
		true,
	);
	expect(UpdateEditorSettingsRequest.safeParse({ appearance: "blue" }).success).toBe(
		false,
	);
});

/** Issue #300: links are https URLs or bare usernames, nothing else. */
test("profile links accept https URLs and GitHub usernames only", () => {
	const ok = (body: unknown) => UpdateProfileRequest.safeParse(body).success;
	expect(ok({ github: "alice-ex" })).toBe(true);
	expect(ok({ github: "https://github.com/alice" })).toBe(true);
	expect(ok({ website: "https://alice.example.edu/" })).toBe(true);
	expect(ok({ github: null, website: null })).toBe(true);

	expect(ok({ github: "http://github.com/alice" })).toBe(false);
	expect(ok({ github: "-alice" })).toBe(false);
	expect(ok({ github: "a--b" })).toBe(false);
	expect(ok({ github: "a".repeat(40) })).toBe(false);
	expect(ok({ website: "alice" })).toBe(false);
	expect(ok({ website: "javascript:alert(1)" })).toBe(false);
	expect(ok({ website: "https://user:pw@example.edu/" })).toBe(false);
	expect(ok({ website: `https://example.edu/${"a".repeat(200)}` })).toBe(false);
	expect(ok({ picture: "x" })).toBe(false);
});

test("a GitHub username links to its profile; a URL is kept as it is", () => {
	expect(githubHref("alice-ex")).toBe("https://github.com/alice-ex");
	expect(githubHref("https://github.com/alice")).toBe("https://github.com/alice");
});
