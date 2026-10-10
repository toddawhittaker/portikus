import { describe, expect, it } from "vitest";
import { TestSigninStart } from "./queries.js";

describe("TestSigninStart", () => {
	it("accepts an https provider address", () => {
		const location = "https://login.example.org/auth?state=abc";
		expect(TestSigninStart.parse({ location })).toEqual({ location });
	});

	it("accepts plain http on loopback, where the mock provider runs", () => {
		expect(
			TestSigninStart.safeParse({ location: "http://127.0.0.1:3002/authorize" })
				.success,
		).toBe(true);
	});

	it.each([
		"http://login.example.org/auth",
		"javascript:alert(1)",
		"/admin/signin",
		"not a url",
	])("refuses %s", (location) => {
		expect(TestSigninStart.safeParse({ location }).success).toBe(false);
	});
});
