import { describe, expect, test } from "vitest";
import { type AuthOptions, mapRole } from "./types.js";

const opts: AuthOptions = {
	publicUrl: "https://portikus.example.edu",
	issuerUrl: "https://idp.example.edu",
	clientId: "portikus",
	clientSecret: "secret",
	scopes: "openid profile email",
	groupsClaim: "groups",
	studentGroup: "portikus-students",
	adminGroup: "portikus-administrators",
	cookieSecret: "cookie-secret",
	sessionTtlSeconds: 43200,
};

describe("mapRole", () => {
	test("maps the student group", () => {
		expect(mapRole({ groups: ["portikus-students"] }, opts)).toBe("student");
	});

	test("maps the administrator group", () => {
		expect(mapRole({ groups: ["portikus-administrators"] }, opts)).toBe(
			"administrator",
		);
	});

	test("administrator wins when the user is in both groups", () => {
		expect(
			mapRole({ groups: ["portikus-students", "portikus-administrators"] }, opts),
		).toBe("administrator");
	});

	test("accepts a single string claim", () => {
		expect(mapRole({ groups: "portikus-students" }, opts)).toBe("student");
	});

	test("denies a user in neither group", () => {
		expect(mapRole({ groups: ["everyone"] }, opts)).toBeNull();
	});

	test("denies when the claim is missing or not strings", () => {
		expect(mapRole({}, opts)).toBeNull();
		expect(mapRole({ groups: [1, 2] }, opts)).toBeNull();
		expect(mapRole({ groups: null }, opts)).toBeNull();
	});

	test("reads the configured claim name", () => {
		const custom = { ...opts, groupsClaim: "roles" };
		expect(
			mapRole(
				{ groups: ["portikus-administrators"], roles: ["portikus-students"] },
				custom,
			),
		).toBe("student");
	});
});
