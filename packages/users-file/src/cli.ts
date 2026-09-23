import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { toDexStaticPasswords } from "./dex.js";
import { readUsersFile, UsersFileError, writeUsersFile } from "./file.js";
import { PromptAborted, Prompter, readFirstLine, type TtyInput } from "./prompt.js";
import {
	type Role,
	roles,
	USERNAME_PATTERN,
	type User,
	type UsersFile,
} from "./schema.js";

export const BCRYPT_COST = 12;
export const MIN_PASSWORD_LENGTH = 12;
// bcrypt ignores everything after 72 bytes, so a longer password is refused.
export const MAX_PASSWORD_BYTES = 72;

export function hashPassword(password: string): Promise<string> {
	return bcrypt.hash(password, BCRYPT_COST);
}

// Returns a reason the password is refused, or undefined when it is acceptable.
export function passwordProblem(password: string): string | undefined {
	if (password.length < MIN_PASSWORD_LENGTH) {
		return `the password must be at least ${MIN_PASSWORD_LENGTH} characters`;
	}
	if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) {
		return `the password must be at most ${MAX_PASSWORD_BYTES} bytes`;
	}
	return undefined;
}

export type CliIo = {
	stdin: TtyInput;
	stdout: NodeJS.WritableStream;
	stderr: NodeJS.WritableStream;
	env: NodeJS.ProcessEnv;
	defaultPath: string;
};

const usage = `Usage: users <command> [options]

Commands:
  add <username>     Create or update a user; asks for the password twice
  remove <username>  Remove a user
  list               List users (never shows hashes)
  check              Validate the users file
  render-dex         Print Dex staticPasswords as JSON (for Ansible)

Options:
  --file <path>      The users file (default: $PORTIKUS_USERS_FILE or ~/.config/portikus/users.json)
  --email, --name, --role   Values for add; asked for when omitted
  --password-stdin   For tests: read the password from one line of stdin
`;

class UsageError extends Error {}

export async function runCli(argv: string[], io: CliIo): Promise<number> {
	try {
		return await dispatch(argv, io);
	} catch (error) {
		if (error instanceof UsageError) {
			io.stderr.write(`${error.message}\n\n${usage}`);
			return 2;
		}
		if (error instanceof UsersFileError) {
			io.stderr.write(`error: ${error.message}\n`);
			return 1;
		}
		if (error instanceof PromptAborted) {
			io.stderr.write("cancelled; nothing was changed\n");
			return 130;
		}
		throw error;
	}
}

async function dispatch(argv: string[], io: CliIo): Promise<number> {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			file: { type: "string" },
			email: { type: "string" },
			name: { type: "string" },
			role: { type: "string" },
			"password-stdin": { type: "boolean" },
			help: { type: "boolean" },
		},
	});
	if (values.help) {
		io.stdout.write(usage);
		return 0;
	}
	const [command, username, ...extra] = positionals;
	const path = values.file ?? io.env.PORTIKUS_USERS_FILE ?? io.defaultPath;
	const takesUsername = command === "add" || command === "remove";
	const unexpected = takesUsername ? extra[0] : (username ?? extra[0]);
	if (unexpected !== undefined) {
		throw new UsageError(`unexpected argument: ${unexpected}`);
	}
	switch (command) {
		case "add":
			if (!username) throw new UsageError("add needs a username");
			return add(path, username, values, io);
		case "remove":
			if (!username) throw new UsageError("remove needs a username");
			return remove(path, username, io);
		case "list":
			return list(path, io);
		case "check":
			return check(path, io);
		case "render-dex":
			return renderDex(path, io);
		default:
			throw new UsageError(command ? `unknown command: ${command}` : "no command");
	}
}

type AddOptions = {
	email?: string;
	name?: string;
	role?: string;
	"password-stdin"?: boolean;
};

async function add(
	path: string,
	username: string,
	options: AddOptions,
	io: CliIo,
): Promise<number> {
	if (!USERNAME_PATTERN.test(username)) {
		throw new UsageError(`the username must match ${USERNAME_PATTERN.source}`);
	}
	if (options.role !== undefined && !isRole(options.role)) {
		throw new UsageError(`the role must be one of: ${roles.join(", ")}`);
	}
	const file: UsersFile = (await readUsersFile(path)) ?? { version: 1, users: [] };
	const current = file.users.find((u) => u.username === username);

	let email: string;
	let displayName: string;
	let role: Role;
	let password: string;
	if (options["password-stdin"]) {
		if (io.stdin.isTTY) {
			throw new UsageError("--password-stdin is for piped input, not a terminal");
		}
		email = options.email ?? current?.email ?? "";
		displayName = options.name ?? current?.displayName ?? "";
		role = (options.role as Role | undefined) ?? current?.role ?? "student";
		assertFirstIsAdministrator(file, username, role);
		password = await readFirstLine(io.stdin);
		const problem = passwordProblem(password);
		if (problem) throw new UsersFileError(problem);
	} else {
		if (!io.stdin.isTTY || !io.stdin.setRawMode) {
			throw new UsageError(
				"add must run in a terminal, so the password can be typed without echo",
			);
		}
		const prompter = new Prompter(io.stdin, io.stderr);
		try {
			email = await askEmail(prompter, io, options.email ?? current?.email);
			displayName = await askWithDefault(
				prompter,
				"Display name",
				options.name ?? current?.displayName,
			);
			role = await askRole(
				prompter,
				io,
				(options.role as Role | undefined) ?? current?.role ?? "student",
			);
			// Said before the password, so nobody types one for nothing.
			assertFirstIsAdministrator(file, username, role);
			password = await askPassword(prompter, io);
		} finally {
			prompter.close();
		}
	}

	const user: User = {
		username,
		email,
		displayName,
		role,
		userId: current?.userId ?? randomUUID(),
		passwordHash: await hashPassword(password),
		passwordChangedAt: new Date().toISOString(),
	};
	const users = current
		? file.users.map((u) => (u.username === username ? user : u))
		: [...file.users, user];
	await writeUsersFile(path, { version: 1, users });
	io.stderr.write(`${current ? "updated" : "added"} ${username} in ${path}\n`);
	return 0;
}

function assertFirstIsAdministrator(
	file: UsersFile,
	username: string,
	role: Role,
): void {
	const others = file.users.filter((u) => u.username !== username);
	if (others.length === 0 && role !== "administrator") {
		throw new UsersFileError("the first user must be an administrator");
	}
}

function isRole(value: string): value is Role {
	return (roles as readonly string[]).includes(value);
}

async function askWithDefault(
	prompter: Prompter,
	label: string,
	fallback: string | undefined,
): Promise<string> {
	for (;;) {
		const answer = (
			await prompter.ask(fallback ? `${label} [${fallback}]: ` : `${label}: `, {
				echo: true,
			})
		).trim();
		const value = answer || fallback;
		if (value) return value;
	}
}

async function askEmail(
	prompter: Prompter,
	io: CliIo,
	fallback: string | undefined,
): Promise<string> {
	for (;;) {
		const value = await askWithDefault(prompter, "Email", fallback);
		if (z.email().safeParse(value).success) return value;
		io.stderr.write("that is not a valid email address\r\n");
	}
}

async function askRole(prompter: Prompter, io: CliIo, fallback: Role): Promise<Role> {
	for (;;) {
		const value = await askWithDefault(prompter, `Role (${roles.join("/")})`, fallback);
		if (isRole(value)) return value;
		io.stderr.write(`the role must be one of: ${roles.join(", ")}\r\n`);
	}
}

async function askPassword(prompter: Prompter, io: CliIo): Promise<string> {
	for (;;) {
		const first = await prompter.ask("Password: ", { echo: false });
		const problem = passwordProblem(first);
		if (problem) {
			io.stderr.write(`${problem}; try again\r\n`);
			continue;
		}
		const second = await prompter.ask("Password again: ", { echo: false });
		if (first === second) return first;
		io.stderr.write("the passwords do not match; try again\r\n");
	}
}

async function remove(path: string, username: string, io: CliIo): Promise<number> {
	const file = await readUsersFile(path);
	if (!file?.users.some((u) => u.username === username)) {
		throw new UsersFileError(`no user named ${username} in ${path}`);
	}
	await writeUsersFile(path, {
		version: 1,
		users: file.users.filter((u) => u.username !== username),
	});
	io.stderr.write(`removed ${username} from ${path}\n`);
	return 0;
}

async function list(path: string, io: CliIo): Promise<number> {
	const file = await readUsersFile(path);
	if (!file) throw new UsersFileError(`${path} does not exist`);
	const rows = file.users.map((u) => [
		u.username,
		u.email,
		u.role,
		u.passwordChangedAt?.slice(0, 10) ?? "unknown",
	]);
	const header = ["USERNAME", "EMAIL", "ROLE", "PASSWORD CHANGED"];
	const widths = header.map((h, i) =>
		Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
	);
	for (const row of [header, ...rows]) {
		io.stdout.write(
			`${row
				.map((cell, i) => cell.padEnd(widths[i] ?? 0))
				.join("  ")
				.trimEnd()}\n`,
		);
	}
	return 0;
}

async function check(path: string, io: CliIo): Promise<number> {
	if (!existsSync(path)) throw new UsersFileError(`${path} does not exist`);
	// readUsersFile checks the location, the mode, and the full schema.
	const file = await readUsersFile(path);
	io.stdout.write(`${path}: ok, ${file?.users.length ?? 0} users\n`);
	return 0;
}

async function renderDex(path: string, io: CliIo): Promise<number> {
	const file = await readUsersFile(path);
	if (!file) throw new UsersFileError(`${path} does not exist`);
	io.stdout.write(`${JSON.stringify(toDexStaticPasswords(file), null, 2)}\n`);
	return 0;
}
