import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { toDexStaticPasswords } from "./dex.js";
import { type User, type UsersFile, validateUsersFile } from "./schema.js";

const fixturePath = new URL(
	"../../../infra/tests/fixtures/users.sample.json",
	import.meta.url,
);
const fixture = (): UsersFile => JSON.parse(readFileSync(fixturePath, "utf8"));

function errorsFor(mutate: (file: UsersFile) => void): string[] {
	const file = fixture();
	mutate(file);
	const result = validateUsersFile(file);
	expect(result.ok).toBe(false);
	return result.ok ? [] : result.errors;
}

describe("validateUsersFile", () => {
	it("accepts the sample fixture", () => {
		expect(validateUsersFile(fixture())).toMatchObject({ ok: true });
	});

	it("rejects a duplicate username and names it", () => {
		const errors = errorsFor((f) => {
			f.users.push({
				...structuredClone(f.users[1] as User),
				email: "other@example.edu",
			});
		});
		expect(errors).toEqual(["user alice: duplicate username"]);
	});

	it("rejects a duplicate email in any case", () => {
		const errors = errorsFor((f) => {
			(f.users[1] as User).email = "CAROL@Example.edu";
		});
		expect(errors).toEqual(["user alice: duplicate email CAROL@Example.edu"]);
	});

	it.each([
		["not a hash", "not-a-hash"],
		["cost 09", "$2b$09$MGOrI4Vq522K69kyskhWsetEom1fjLdaDyzNB.G7ktesUbWKQEFfG"],
		["cost 13", "$2b$13$MGOrI4Vq522K69kyskhWsetEom1fjLdaDyzNB.G7ktesUbWKQEFfG"],
		["cost 16", "$2b$16$MGOrI4Vq522K69kyskhWsetEom1fjLdaDyzNB.G7ktesUbWKQEFfG"],
		["cost 17", "$2b$17$MGOrI4Vq522K69kyskhWsetEom1fjLdaDyzNB.G7ktesUbWKQEFfG"],
		["wrong prefix", "$2x$12$MGOrI4Vq522K69kyskhWsetEom1fjLdaDyzNB.G7ktesUbWKQEFfG"],
		["short", "$2b$12$MGOrI4Vq522K69kyskhWsetEom1fjLdaDyzNB.G7ktesUbWKQEF"],
	])("rejects a bad hash (%s)", (_label, hash) => {
		const errors = errorsFor((f) => {
			(f.users[1] as User).passwordHash = hash;
		});
		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatch(/^user alice: passwordHash: must be a bcrypt hash/);
	});

	it("rejects a bad role", () => {
		const errors = errorsFor((f) => {
			(f.users[1] as { role: string }).role = "teacher";
		});
		expect(errors[0]).toMatch(/^user alice: role:/);
	});

	it("rejects an unknown key on a user and on the file", () => {
		expect(
			errorsFor((f) => {
				(f.users[1] as Record<string, unknown>).password = "x";
			})[0],
		).toMatch(/^user alice: .*password/);
		expect(
			errorsFor((f) => {
				(f as Record<string, unknown>).extra = true;
			})[0],
		).toMatch(/^file: .*extra/);
	});

	it("rejects a file with no administrator", () => {
		const errors = errorsFor((f) => {
			(f.users[0] as User).role = "student";
		});
		expect(errors).toEqual([
			"file: at least one user must have the role administrator",
		]);
	});

	it("rejects a bad username, email, userId and version", () => {
		expect(
			errorsFor((f) => {
				(f.users[1] as User).username = "Alice";
			})[0],
		).toMatch(/^user Alice: username/);
		expect(
			errorsFor((f) => {
				(f.users[1] as User).email = "nope";
			})[0],
		).toMatch(/^user alice: email/);
		expect(
			errorsFor((f) => {
				(f.users[1] as User).userId = "alice";
			})[0],
		).toMatch(/^user alice: userId/);
		expect(
			errorsFor((f) => {
				(f as { version: number }).version = 2;
			})[0],
		).toMatch(/^file: version/);
	});

	it("names an entry without a username by its position", () => {
		const errors = errorsFor((f) => {
			(f.users as unknown[]).push({});
		});
		expect(errors[0]).toMatch(/^user #3: /);
	});
});

describe("toDexStaticPasswords", () => {
	it("renders one entry per user with the group for the role", () => {
		const file = fixture();
		expect(toDexStaticPasswords(file)).toEqual([
			{
				email: "carol@example.edu",
				hash: (file.users[0] as User).passwordHash,
				username: "carol",
				name: "Carol Administrator",
				preferredUsername: "carol",
				userID: "f671d6f5-6742-494d-bedb-3c88e9a63bf4",
				emailVerified: true,
				groups: ["portikus-administrators"],
			},
			{
				email: "alice@example.edu",
				hash: (file.users[1] as User).passwordHash,
				username: "alice",
				name: "Alice Student",
				preferredUsername: "alice",
				userID: "b463e705-b096-4d17-b28b-b92e2b0157fd",
				emailVerified: true,
				groups: ["portikus-students"],
			},
		]);
	});

	it("gives an instructor the instructor group", () => {
		const file = fixture();
		(file.users[1] as User).role = "instructor";
		expect(validateUsersFile(file).ok).toBe(true);
		expect(toDexStaticPasswords(file)[1]?.groups).toEqual(["instructor"]);
	});
});
