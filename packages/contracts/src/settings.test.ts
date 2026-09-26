import { expect, test } from "vitest";
import {
	AdminUser,
	AdminUserList,
	CreateDexUserRequest,
	DEFAULT_ACCEPTABLE_USE_TEXT,
	DEFAULT_TIMEZONE,
	EDITOR_SETTINGS_DEFAULTS,
	EditorSettings,
	githubHref,
	MAX_ACCEPTABLE_USE_LENGTH,
	MeSettings,
	PlatformSettings,
	SetLogLevelRequest,
	systemTimezones,
	UpdateAdminUserSettingsRequest,
	UpdateEditorSettingsRequest,
	UpdatePlatformSettingsRequest,
	UpdateProfileRequest,
} from "./index.js";

/** The resource guard and acceptable-use fields at their migration defaults. */
const GUARD_SETTINGS = {
	cpuGuardThresholdPercent: 80,
	memoryGuardThresholdPercent: 90,
	guardWindowMinutes: 30,
	cpuThrottleSharePercent: 25,
	cpuIdleLiftMinutes: 5,
	cpuIdleLiftPercent: 10,
	idleStopMinutes: 60,
	acceptableUseText: null,
	acceptableUseVersion: 1,
};

test("PlatformSettings accepts the guard defaults and a custom statement", () => {
	const base = { shutdownGraceSeconds: 600, logLevel: null, updatedAt: null };
	expect(PlatformSettings.parse({ ...base, ...GUARD_SETTINGS })).toEqual({
		...base,
		...GUARD_SETTINGS,
	});
	expect(
		PlatformSettings.parse({
			...base,
			...GUARD_SETTINGS,
			acceptableUseText: "Be kind.",
			acceptableUseVersion: 3,
		}).acceptableUseText,
	).toBe("Be kind.");
	expect(
		PlatformSettings.safeParse({ ...base, ...GUARD_SETTINGS, acceptableUseVersion: 0 })
			.success,
	).toBe(false);
	const { idleStopMinutes: _dropped, ...missing } = GUARD_SETTINGS;
	expect(PlatformSettings.safeParse({ ...base, ...missing }).success).toBe(false);
});

test("UpdatePlatformSettingsRequest takes each guard field on its own, in range", () => {
	const ok: Array<[string, number]> = [
		["cpuGuardThresholdPercent", 1],
		["cpuGuardThresholdPercent", 100],
		["memoryGuardThresholdPercent", 1],
		["memoryGuardThresholdPercent", 100],
		["guardWindowMinutes", 5],
		["guardWindowMinutes", 240],
		["cpuThrottleSharePercent", 5],
		["cpuThrottleSharePercent", 100],
		["cpuIdleLiftMinutes", 1],
		["cpuIdleLiftMinutes", 60],
		["cpuIdleLiftPercent", 0],
		["cpuIdleLiftPercent", 100],
		["idleStopMinutes", 0],
		["idleStopMinutes", 10],
		["idleStopMinutes", 1440],
	];
	for (const [key, value] of ok) {
		expect(UpdatePlatformSettingsRequest.safeParse({ [key]: value }).success, key).toBe(
			true,
		);
	}
	const bad: Array<[string, unknown]> = [
		["cpuGuardThresholdPercent", 0],
		["cpuGuardThresholdPercent", 101],
		["memoryGuardThresholdPercent", 0],
		["memoryGuardThresholdPercent", 101],
		["guardWindowMinutes", 4],
		["guardWindowMinutes", 241],
		["cpuThrottleSharePercent", 4],
		["cpuThrottleSharePercent", 101],
		["cpuIdleLiftMinutes", 0],
		["cpuIdleLiftMinutes", 61],
		["cpuIdleLiftPercent", -1],
		["cpuIdleLiftPercent", 101],
		["cpuIdleLiftPercent", 10.5],
		["idleStopMinutes", 9],
		["idleStopMinutes", 1441],
		["idleStopMinutes", -1],
		["cpuGuardThresholdPercent", 80.5],
		["guardWindowMinutes", "30"],
		["idleStopMinutes", null],
	];
	for (const [key, value] of bad) {
		expect(
			UpdatePlatformSettingsRequest.safeParse({ [key]: value }).success,
			`${key}=${String(value)}`,
		).toBe(false);
	}
});

test("UpdatePlatformSettingsRequest takes a statement, or null for the default", () => {
	expect(
		UpdatePlatformSettingsRequest.parse({ acceptableUseText: "  Be kind.  " })
			.acceptableUseText,
	).toBe("Be kind.");
	expect(
		UpdatePlatformSettingsRequest.parse({ acceptableUseText: null }).acceptableUseText,
	).toBeNull();
	expect(
		UpdatePlatformSettingsRequest.safeParse({ acceptableUseText: "   " }).success,
	).toBe(false);
	expect(
		UpdatePlatformSettingsRequest.safeParse({
			acceptableUseText: "a".repeat(MAX_ACCEPTABLE_USE_LENGTH),
		}).success,
	).toBe(true);
	expect(
		UpdatePlatformSettingsRequest.safeParse({
			acceptableUseText: "a".repeat(MAX_ACCEPTABLE_USE_LENGTH + 1),
		}).success,
	).toBe(false);
	// The version is read-only.
	expect(
		UpdatePlatformSettingsRequest.safeParse({ acceptableUseVersion: 2 }).success,
	).toBe(false);
});

test("the default statement is five short paragraphs within the limit", () => {
	const paragraphs = DEFAULT_ACCEPTABLE_USE_TEXT.split("\n\n");
	expect(paragraphs).toHaveLength(5);
	for (const paragraph of paragraphs) expect(paragraph.trim()).toBe(paragraph);
	expect(DEFAULT_ACCEPTABLE_USE_TEXT.length).toBeLessThanOrEqual(
		MAX_ACCEPTABLE_USE_LENGTH,
	);
	expect(DEFAULT_ACCEPTABLE_USE_TEXT).toMatch(/coursework/);
	expect(DEFAULT_ACCEPTABLE_USE_TEXT).toMatch(/mine cryptocurrency/);
	expect(DEFAULT_ACCEPTABLE_USE_TEXT).toMatch(/not your files/);
	expect(DEFAULT_ACCEPTABLE_USE_TEXT).toMatch(/end your access/);
	expect(DEFAULT_ACCEPTABLE_USE_TEXT).toMatch(/institution's own rules/);
});

test("PlatformSettings accepts zero, meaning no shutdown", () => {
	const parsed = PlatformSettings.parse({
		...GUARD_SETTINGS,
		shutdownGraceSeconds: 0,
		logLevel: null,
		updatedAt: null,
	});
	expect(parsed.shutdownGraceSeconds).toBe(0);
	expect(parsed.logLevel).toBeNull();
});

test("PlatformSettings accepts an ISO timestamp", () => {
	const parsed = PlatformSettings.parse({
		...GUARD_SETTINGS,
		shutdownGraceSeconds: 600,
		logLevel: "debug",
		updatedAt: "2026-09-17T10:00:00.000Z",
	});
	expect(parsed.updatedAt).toBe("2026-09-17T10:00:00.000Z");
});

test("PlatformSettings rejects a non-ISO timestamp", () => {
	expect(() =>
		PlatformSettings.parse({
			...GUARD_SETTINGS,
			shutdownGraceSeconds: 600,
			logLevel: null,
			updatedAt: "yesterday",
		}),
	).toThrow();
});

test("PlatformSettings rejects a log level we do not have", () => {
	expect(() =>
		PlatformSettings.parse({
			...GUARD_SETTINGS,
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
	providerRole: "student",
	grantedRole: null,
	disabledAt: null,
	shutdownGraceSeconds: null,
	dexLocal: false,
	preferredUsername: null,
	issuer: null,
	lastLoginAt: null,
	markers: {
		disabled: false,
		archived: false,
		duplicateEmail: false,
		stale: false,
		linked: false,
	},
	workspace: null,
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
		AdminUser.parse({ ...sampleAdminUser, grantedRole: "student" }),
	).toThrow();
	const { linked: _linked, ...oldMarkers } = sampleAdminUser.markers;
	expect(() => AdminUser.parse({ ...sampleAdminUser, markers: oldMarkers })).toThrow();
	expect(() =>
		AdminUser.parse({ ...sampleAdminUser, shutdownGraceSeconds: -1 }),
	).toThrow();
});

test("AdminUserList parses a list of users", () => {
	const parsed = AdminUserList.parse({ users: [sampleAdminUser], dexUsers: false });
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
		screenReaderMode: false,
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

/**
 * Issue #357: screen-reader mode is off unless the student turns it on. With
 * it on, xterm.js drops text that arrives without a key press (emoji
 * pickers, dictation), so it is not forced on everyone.
 */
test("screen-reader mode defaults to off and takes only a boolean", () => {
	expect(EDITOR_SETTINGS_DEFAULTS.screenReaderMode).toBe(false);
	expect(
		UpdateEditorSettingsRequest.safeParse({ screenReaderMode: true }).success,
	).toBe(true);
	expect(
		UpdateEditorSettingsRequest.safeParse({ screenReaderMode: "on" }).success,
	).toBe(false);
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

test("CreateDexUserRequest lowercases the email and takes the three roles", () => {
	expect(
		CreateDexUserRequest.parse({
			name: "  Dana Kim ",
			email: " Dana@Example.EDU ",
			username: "dana.k_2-x",
			role: "instructor",
		}),
	).toEqual({
		name: "Dana Kim",
		email: "dana@example.edu",
		username: "dana.k_2-x",
		role: "instructor",
	});
});

test("CreateDexUserRequest refuses a bad name, email, username or role, and extra fields", () => {
	const good = { name: "A", email: "a@example.edu", username: "a", role: "student" };
	expect(
		CreateDexUserRequest.safeParse({ ...good, name: "x".repeat(100) }).success,
	).toBe(true);
	const { name: _name, ...noName } = good;
	for (const bad of [
		noName,
		{ ...good, name: "" },
		{ ...good, name: "   " },
		{ ...good, name: "x".repeat(101) },
		{ ...good, email: "no-at-sign" },
		{ ...good, username: "" },
		{ ...good, username: "has space" },
		{ ...good, username: "x".repeat(65) },
		{ ...good, role: "owner" },
		{ ...good, password: "chosen" },
	]) {
		expect(CreateDexUserRequest.safeParse(bad).success, JSON.stringify(bad)).toBe(
			false,
		);
	}
});
