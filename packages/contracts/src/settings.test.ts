import { expect, test } from "vitest";
import {
	AdminUser,
	AdminUserList,
	PlatformSettings,
	UpdateAdminUserSettingsRequest,
	UpdatePlatformSettingsRequest,
} from "./index.js";

test("PlatformSettings accepts zero, meaning no shutdown", () => {
	const parsed = PlatformSettings.parse({
		shutdownGraceSeconds: 0,
		updatedAt: null,
	});
	expect(parsed.shutdownGraceSeconds).toBe(0);
});

test("PlatformSettings accepts an ISO timestamp", () => {
	const parsed = PlatformSettings.parse({
		shutdownGraceSeconds: 600,
		updatedAt: "2026-09-17T10:00:00.000Z",
	});
	expect(parsed.updatedAt).toBe("2026-09-17T10:00:00.000Z");
});

test("PlatformSettings rejects a non-ISO timestamp", () => {
	expect(() =>
		PlatformSettings.parse({ shutdownGraceSeconds: 600, updatedAt: "yesterday" }),
	).toThrow();
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
