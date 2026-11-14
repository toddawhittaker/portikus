import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { readClaudeSignIn } from "./claude-sign-in.js";

let dir: string | null = null;

afterEach(async () => {
	if (dir) await rm(dir, { recursive: true, force: true });
	dir = null;
});

/** A stand-in `claude` that prints this and exits with this code, as `claude auth status` does. */
async function fakeClaude(output: string, code: number): Promise<string> {
	dir = await mkdtemp(join(tmpdir(), "portikus-claude-auth-"));
	const path = join(dir, "claude");
	await writeFile(join(dir, "out.json"), output);
	await writeFile(
		path,
		`#!/bin/sh\n[ "$1 $2 $3" = "auth status --json" ] || exit 9\ncat "${join(dir, "out.json")}"\nexit ${code}\n`,
	);
	await chmod(path, 0o755);
	return path;
}

describe("readClaudeSignIn", () => {
	test("signed in when Claude Code says loggedIn", async () => {
		const claude = await fakeClaude(
			JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "a@b.edu" }),
			0,
		);
		expect(await readClaudeSignIn(claude, tmpdir())).toBe("signedIn");
	});

	test("signed out from the output, though Claude Code exits 1", async () => {
		const claude = await fakeClaude(
			JSON.stringify({ loggedIn: false, authMethod: "none" }),
			1,
		);
		expect(await readClaudeSignIn(claude, tmpdir())).toBe("signedOut");
	});

	test("unknown when the output is not the JSON expected", async () => {
		expect(await readClaudeSignIn(await fakeClaude("Logged in.", 0), tmpdir())).toBe(
			"unknown",
		);
		expect(await readClaudeSignIn(await fakeClaude("{}", 0), tmpdir())).toBe("unknown");
		expect(await readClaudeSignIn(await fakeClaude("null", 0), tmpdir())).toBe(
			"unknown",
		);
	});

	test("unknown when there is no Claude Code", async () => {
		expect(await readClaudeSignIn("/nonexistent/claude", tmpdir())).toBe("unknown");
	});
});
