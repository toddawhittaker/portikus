import { expect, test } from "vitest";
import {
	AdminUser,
	AdminUserList,
	EDITOR_SETTINGS_DEFAULTS,
	EditorSettings,
	PlatformSettings,
	SetLogLevelRequest,
	UpdateAdminUserSettingsRequest,
	UpdateEditorSettingsRequest,
	UpdatePlatformSettingsRequest,
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
		wordWrap: false,
		terminalTheme: "dark",
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
