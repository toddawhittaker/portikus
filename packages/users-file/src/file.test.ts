import { chmodSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readUsersFile, UsersFileError, writeUsersFile } from "./file.js";
import type { User, UsersFile } from "./schema.js";

const fixture = (): UsersFile =>
	JSON.parse(
		readFileSync(
			new URL("../../../infra/tests/fixtures/users.sample.json", import.meta.url),
			"utf8",
		),
	);

let root: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "users-file-"));
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("writeUsersFile", () => {
	it("creates the directory 0700 and the file 0600 even with a loose umask", async () => {
		const path = join(root, "config", "portikus", "users.json");
		const old = process.umask(0o000);
		try {
			await writeUsersFile(path, fixture());
		} finally {
			process.umask(old);
		}
		expect(statSync(join(root, "config", "portikus")).mode & 0o777).toBe(0o700);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(await readUsersFile(path)).toEqual(fixture());
	});

	it("leaves no temporary file behind", async () => {
		const path = join(root, "users.json");
		await writeUsersFile(path, fixture());
		await writeUsersFile(path, fixture());
		expect(readdirSync(root)).toEqual(["users.json"]);
	});

	it("refuses to overwrite a world-readable file and says how to fix it", async () => {
		const path = join(root, "users.json");
		await writeUsersFile(path, fixture());
		chmodSync(path, 0o644);
		await expect(writeUsersFile(path, fixture())).rejects.toThrow(`chmod 600 ${path}`);
		await expect(readUsersFile(path)).rejects.toThrow(/mode 0644/);
	});

	it("refuses a group-readable file", async () => {
		const path = join(root, "users.json");
		await writeUsersFile(path, fixture());
		chmodSync(path, 0o640);
		await expect(readUsersFile(path)).rejects.toBeInstanceOf(UsersFileError);
	});

	it("refuses a path inside a Git work tree", async () => {
		mkdirSync(join(root, "repo", ".git"), { recursive: true });
		const path = join(root, "repo", "sub", "users.json");
		await expect(writeUsersFile(path, fixture())).rejects.toThrow(/Git work tree/);
		await expect(readUsersFile(path)).rejects.toThrow(/Git work tree/);
	});

	it("refuses to write an invalid file", async () => {
		const file = fixture();
		(file.users[0] as User).role = "student";
		await expect(writeUsersFile(join(root, "users.json"), file)).rejects.toThrow(
			/administrator/,
		);
	});
});

describe("readUsersFile", () => {
	it("returns undefined for a missing file", async () => {
		expect(await readUsersFile(join(root, "users.json"))).toBeUndefined();
	});
});
