import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import bcrypt from "bcryptjs";
import { type IPty, spawn } from "node-pty";
import { afterEach, beforeEach, expect, it } from "vitest";

// Drives the real command under a pseudo-terminal, the way a person would.
const packageDir = fileURLToPath(new URL("..", import.meta.url));
const PASSWORD = "pty-secret-password-42";

let root: string;
let child: IPty | undefined;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "users-pty-"));
});
afterEach(async () => {
	// A failed assertion must not leave the command running.
	child?.kill();
	child = undefined;
	await rm(root, { recursive: true, force: true });
});

it("never echoes the password to the terminal", async () => {
	const path = join(root, "users.json");
	const pty = spawn(
		process.execPath,
		["--import", "tsx", "src/main.ts", "add", "carol", "--file", path],
		{ cwd: packageDir, cols: 120, rows: 30, env: { PATH: process.env.PATH ?? "" } },
	);
	child = pty;
	let output = "";
	const answers: [string, string][] = [
		["Email: ", "carol@example.edu"],
		["Display name: ", "Carol Admin"],
		["Role (student/instructor/administrator) [student]: ", "administrator"],
		["Password: ", PASSWORD],
		["Password again: ", "a different password"],
		["try again", ""],
		["Password: ", PASSWORD],
		["Password again: ", PASSWORD],
	];
	const exit = new Promise<number>((resolve) => {
		pty.onExit(({ exitCode }) => resolve(exitCode));
	});
	let next = 0;
	let seen = 0;
	pty.onData((data) => {
		output += data;
		while (next < answers.length) {
			const [prompt, answer] = answers[next] as [string, string];
			const at = output.indexOf(prompt, seen);
			if (at < 0) break;
			seen = at + prompt.length;
			next += 1;
			if (prompt !== "try again") pty.write(`${answer}\r`);
		}
	});
	const code = await exit;
	expect(output).toContain("added carol");
	expect(code).toBe(0);
	expect(output).not.toContain(PASSWORD);
	expect(output).not.toContain("a different password");
	expect(output).not.toContain("*");
	expect(output).toContain("carol@example.edu");
	const file = JSON.parse(readFileSync(path, "utf8"));
	expect(await bcrypt.compare(PASSWORD, file.users[0].passwordHash)).toBe(true);
}, 30_000);
