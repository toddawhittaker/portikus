import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import bcrypt from "bcryptjs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashPassword, passwordProblem, runCli } from "./cli.js";
import type { User, UsersFile } from "./schema.js";

const PASSWORD = "correct horse battery";

function sink() {
	let text = "";
	const stream = new Writable({
		write(chunk, _encoding, done) {
			text += chunk.toString();
			done();
		},
	});
	return { stream, text: () => text };
}

type FakeInput = PassThrough & { isTTY?: boolean; setRawMode?: (m: boolean) => void };

function terminal(typed: string): { input: FakeInput; rawModes: boolean[] } {
	const rawModes: boolean[] = [];
	const input: FakeInput = new PassThrough();
	input.isTTY = true;
	input.setRawMode = (mode) => {
		rawModes.push(mode);
	};
	input.write(typed);
	return { input, rawModes };
}

function piped(text: string): FakeInput {
	const input: FakeInput = new PassThrough();
	input.end(text);
	return input;
}

let root: string;
let path: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "users-cli-"));
	path = join(root, "users.json");
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

async function run(argv: string[], stdin: FakeInput) {
	const out = sink();
	const err = sink();
	const code = await runCli(argv, {
		stdin,
		stdout: out.stream,
		stderr: err.stream,
		env: { PORTIKUS_USERS_FILE: path },
		defaultPath: "/nonexistent/users.json",
	});
	return { code, stdout: out.text(), stderr: err.text() };
}

const readFile = (): UsersFile => JSON.parse(readFileSync(path, "utf8"));

async function addCarol() {
	return run(
		[
			"add",
			"carol",
			"--email",
			"carol@example.edu",
			"--name",
			"Carol A",
			"--role",
			"administrator",
			"--password-stdin",
		],
		piped(`${PASSWORD}\n`),
	);
}

describe("hashing", () => {
	it("hashes with bcrypt cost 12 and verifies", async () => {
		const hash = await hashPassword(PASSWORD);
		expect(hash).toMatch(/^\$2b\$12\$/);
		expect(await bcrypt.compare(PASSWORD, hash)).toBe(true);
		expect(await bcrypt.compare("wrong password!", hash)).toBe(false);
	});

	it("refuses short and over-long passwords", () => {
		expect(passwordProblem("elevenchars")).toMatch(/at least 12/);
		expect(passwordProblem("twelve chars")).toBeUndefined();
		expect(passwordProblem("é".repeat(37))).toMatch(/at most 72 bytes/);
	});
});

describe("add", () => {
	it("prompts in a terminal, hides the password, and asks again on a mismatch", async () => {
		const { input, rawModes } = terminal(
			[
				"not-an-email\r",
				"carol@example.edu\r",
				"Carol Admin\r",
				"teacher\r",
				"administrator\r",
				"short\r",
				`${PASSWORD}\r`,
				"something else entirely\r",
				`${PASSWORD}x\u007f\r`,
				`${PASSWORD}\r`,
			].join(""),
		);
		const result = await run(["add", "carol"], input);
		expect(result.code).toBe(0);
		expect(result.stderr).toContain("not a valid email");
		expect(result.stderr).toContain("the role must be one of");
		expect(result.stderr).toContain("at least 12 characters; try again");
		expect(result.stderr).toContain("the passwords do not match; try again");
		expect(result.stderr).toContain("carol@example.edu");
		expect(result.stderr).not.toContain(PASSWORD);
		expect(result.stdout).not.toContain(PASSWORD);
		expect(rawModes).toEqual([true, false]);
		const [user] = readFile().users;
		expect(user).toMatchObject({
			username: "carol",
			email: "carol@example.edu",
			displayName: "Carol Admin",
			role: "administrator",
		});
		expect(await bcrypt.compare(PASSWORD, (user as User).passwordHash)).toBe(true);
	});

	it("accepts the instructor role and offers it in the prompt", async () => {
		await addCarol();
		const { input } = terminal(
			`ivy@example.edu\rIvy Instructor\rinstructor\r${PASSWORD}\r${PASSWORD}\r`,
		);
		const result = await run(["add", "ivy"], input);
		expect(result.code).toBe(0);
		expect(result.stderr).toContain("Role (student/instructor/administrator)");
		expect(readFile().users[1]).toMatchObject({ username: "ivy", role: "instructor" });
	});

	it("offers current values on an update and keeps the userId", async () => {
		await addCarol();
		const before = readFile().users[0] as User;
		const { input } = terminal(`\r\r\r${PASSWORD}2\r${PASSWORD}2\r`);
		const result = await run(["add", "carol"], input);
		expect(result.code).toBe(0);
		expect(result.stderr).toContain("Email [carol@example.edu]: ");
		expect(result.stderr).toContain("updated carol");
		const after = readFile().users[0] as User;
		expect(after.userId).toBe(before.userId);
		expect(after.email).toBe(before.email);
		expect(after.passwordHash).not.toBe(before.passwordHash);
		expect(await bcrypt.compare(`${PASSWORD}2`, after.passwordHash)).toBe(true);
	});

	it("cancels on Ctrl-C without writing", async () => {
		const { input } = terminal("carol@example.edu\r\u0003");
		const result = await run(["add", "carol"], input);
		expect(result.code).toBe(130);
		expect(() => readFile()).toThrow();
	});

	it("refuses to run without a terminal unless --password-stdin is given", async () => {
		const result = await run(["add", "carol"], piped(`${PASSWORD}\n`));
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("must run in a terminal");
	});

	it("refuses --password-stdin on a terminal", async () => {
		const result = await run(["add", "carol", "--password-stdin"], terminal("").input);
		expect(result.code).toBe(2);
	});

	it("reads exactly one line with --password-stdin", async () => {
		const result = await run(
			[
				"add",
				"carol",
				"--email",
				"carol@example.edu",
				"--name",
				"Carol",
				"--role",
				"administrator",
				"--password-stdin",
			],
			piped(`${PASSWORD}\r\nsecond line\n`),
		);
		expect(result.code).toBe(0);
		expect(
			await bcrypt.compare(PASSWORD, (readFile().users[0] as User).passwordHash),
		).toBe(true);
	});

	it("never puts the password in an error message", async () => {
		const short = await run(["add", "carol", "--password-stdin"], piped("tiny\n"));
		expect(short.code).toBe(1);
		expect(short.stderr).not.toContain("tiny");
		const invalid = await run(
			[
				"add",
				"carol",
				"--email",
				"bad",
				"--name",
				"C",
				"--role",
				"administrator",
				"--password-stdin",
			],
			piped(`${PASSWORD}\n`),
		);
		expect(invalid.code).toBe(1);
		expect(invalid.stderr).toContain("user carol: email");
		expect(invalid.stderr).not.toContain(PASSWORD);
	});

	it("says the first user must be an administrator before the password", async () => {
		const result = await run(
			[
				"add",
				"carol",
				"--email",
				"carol@example.edu",
				"--name",
				"Carol",
				"--role",
				"student",
				"--password-stdin",
			],
			piped(`${PASSWORD}\n`),
		);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("the first user must be an administrator");
	});

	it("rejects a bad username and a bad role flag", async () => {
		expect((await run(["add", "Bad Name"], piped(""))).code).toBe(2);
		expect((await run(["add", "carol", "--role", "boss"], piped(""))).code).toBe(2);
	});
});

describe("remove, list, check and render-dex", () => {
	it("lists users without hashes and removes them", async () => {
		await addCarol();
		await run(
			[
				"add",
				"alice",
				"--email",
				"alice@example.edu",
				"--name",
				"Alice",
				"--password-stdin",
			],
			piped(`${PASSWORD}\n`),
		);
		const listed = await run(["list"], piped(""));
		expect(listed.stdout).toMatch(/^USERNAME\s+EMAIL\s+ROLE\s+PASSWORD CHANGED\n/);
		expect(listed.stdout).toMatch(
			/alice\s+alice@example.edu\s+student\s+\d{4}-\d\d-\d\d/,
		);
		expect(listed.stdout).not.toContain("$2b$");

		expect((await run(["remove", "alice"], piped(""))).code).toBe(0);
		expect(readFile().users.map((u) => u.username)).toEqual(["carol"]);
		expect((await run(["remove", "alice"], piped(""))).code).toBe(1);
		// The last administrator cannot be removed.
		const last = await run(["remove", "carol"], piped(""));
		expect(last.code).toBe(1);
		expect(last.stderr).toContain("administrator");
	});

	it("checks a file and reports each problem", async () => {
		await addCarol();
		expect(await run(["check"], piped(""))).toMatchObject({
			code: 0,
			stdout: `${path}: ok, 1 users\n`,
		});
		const file = readFile();
		file.users.push({ ...(file.users[0] as User), email: "CAROL@example.edu" });
		writeFileSync(path, JSON.stringify(file), { mode: 0o600 });
		const bad = await run(["check"], piped(""));
		expect(bad.code).toBe(1);
		expect(bad.stderr).toContain("user carol: duplicate username");
		expect(bad.stderr).toContain("user carol: duplicate email");

		writeFileSync(path, "{not json", { mode: 0o600 });
		expect((await run(["check"], piped(""))).stderr).toContain("not valid JSON");
	});

	it("reports a missing file", async () => {
		for (const command of ["check", "list", "render-dex"]) {
			const result = await run([command], piped(""));
			expect(result.code).toBe(1);
			expect(result.stderr).toContain("does not exist");
		}
	});

	it("renders Dex staticPasswords as JSON", async () => {
		await addCarol();
		const result = await run(["render-dex"], piped(""));
		const [entry] = JSON.parse(result.stdout);
		expect(entry).toMatchObject({
			email: "carol@example.edu",
			username: "carol",
			groups: ["portikus-administrators"],
			userID: (readFile().users[0] as User).userId,
		});
	});

	it("uses --file over the environment, and prints usage", async () => {
		const other = join(root, "other.json");
		const result = await run(["check", "--file", other], piped(""));
		expect(result.stderr).toContain(other);
		expect((await run(["--help"], piped(""))).stdout).toContain("Usage:");
		expect((await run([], piped(""))).code).toBe(2);
		expect((await run(["frobnicate"], piped(""))).stderr).toContain("unknown command");
		expect((await run(["list", "extra"], piped(""))).code).toBe(2);
		expect((await run(["remove"], piped(""))).code).toBe(2);
		expect((await run(["add"], piped(""))).code).toBe(2);
	});
});
