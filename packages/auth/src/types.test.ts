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
	instructorGroup: "portikus-instructors",
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

	test("maps the instructor group, default and configured", () => {
		expect(mapRole({ groups: ["portikus-instructors"] }, opts)).toBe("instructor");
		const custom = { ...opts, instructorGroup: "teachers" };
		expect(mapRole({ groups: ["teachers"] }, custom)).toBe("instructor");
		expect(mapRole({ groups: ["portikus-instructors"] }, custom)).toBeNull();
	});

	test("the highest role wins", () => {
		expect(
			mapRole({ groups: ["portikus-students", "portikus-instructors"] }, opts),
		).toBe("instructor");
		expect(
			mapRole({ groups: ["portikus-instructors", "portikus-administrators"] }, opts),
		).toBe("administrator");
	});

	test("denies when the claim is missing or not strings", () => {
		expect(mapRole({}, opts)).toBeNull();
		expect(mapRole({ groups: [1, 2] }, opts)).toBeNull();
		expect(mapRole({ groups: null }, opts)).toBeNull();
	});

	test("a comma-separated string claim is not split, so it grants nothing", () => {
		// Deliberate: only an exact group name or a JSON array counts. A
		// provider that packs groups into one string must be configured,
		// not guessed at.
		expect(
			mapRole({ groups: "portikus-students,portikus-administrators" }, opts),
		).toBeNull();
		expect(mapRole({ groups: "portikus-students other" }, opts)).toBeNull();
	});

	test("a near-miss group name grants nothing", () => {
		expect(mapRole({ groups: ["portikus-students-x"] }, opts)).toBeNull();
		expect(mapRole({ groups: ["PORTIKUS-STUDENTS"] }, opts)).toBeNull();
		expect(mapRole({ groups: [" portikus-students"] }, opts)).toBeNull();
	});

	test("administrator wins whatever order the groups arrive in", () => {
		expect(
			mapRole({ groups: ["portikus-administrators", "portikus-students"] }, opts),
		).toBe("administrator");
	});

	test("a nested or object-shaped claim grants nothing", () => {
		expect(mapRole({ groups: { name: "portikus-administrators" } }, opts)).toBeNull();
		expect(mapRole({ groups: [["portikus-administrators"]] }, opts)).toBeNull();
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

describe("mapRole with OIDC_DEFAULT_ROLE (docs/EPIC-14.md ruling 11)", () => {
	test("none refuses a user with no matching group", () => {
		expect(mapRole({ groups: [] }, { ...opts, defaultRole: "none" })).toBeNull();
	});

	test("student admits a user with no matching group as a student, never more", () => {
		expect(mapRole({}, { ...opts, defaultRole: "student" })).toBe("student");
	});

	test("a matching group still wins", () => {
		expect(
			mapRole(
				{ groups: ["portikus-instructors"] },
				{ ...opts, defaultRole: "student" },
			),
		).toBe("instructor");
	});
});
