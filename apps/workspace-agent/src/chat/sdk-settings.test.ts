import { describe, expect, test } from "vitest";
import { toSdkEffort, toSdkPermissionMode } from "./sdk-settings.js";

describe("toSdkEffort", () => {
	test("passes the levels the SDK knows", () => {
		for (const level of ["low", "medium", "high", "xhigh", "max"]) {
			expect(toSdkEffort(level)).toBe(level);
		}
	});

	test("an unknown level is left to the SDK's default and never throws", () => {
		for (const level of ["ultra", "", "High", "__proto__", "constructor"]) {
			expect(toSdkEffort(level)).toBeUndefined();
		}
	});
});

describe("toSdkPermissionMode", () => {
	test("passes the modes the chat offers", () => {
		for (const mode of [
			"default",
			"acceptEdits",
			"plan",
			"auto",
			"bypassPermissions",
		]) {
			expect(toSdkPermissionMode(mode)).toBe(mode);
		}
	});

	test("an unknown mode, or one the chat never offers, leaves the mode unchanged", () => {
		for (const mode of ["fullAccess", "dontAsk", "", "Plan", "toString"]) {
			expect(toSdkPermissionMode(mode)).toBeUndefined();
		}
	});
});
