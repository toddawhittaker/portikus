/**
 * The wrapper every ordinary terminal starts in (SPEC.md §9.7): it clears
 * TMUX, and it falls back to a bare shell when the login shell exits at once.
 */
import { spawn } from "node:child_process";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { SHELL_WRAPPER } from "./tmux.js";

const MESSAGE = "Your ~/.bashrc made the shell exit; this terminal skipped it.";

/** A stand-in login shell with the given body. */
async function fakeShell(body: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "portikus-shell-"));
	const path = join(dir, "shell");
	await writeFile(path, `#!/bin/sh\n${body}\n`);
	await chmod(path, 0o755);
	return path;
}

function runWrapper(
	shell: string,
	input: string,
): Promise<{ code: number | null; stdout: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(SHELL_WRAPPER, [], {
			env: {
				...process.env,
				SHELL: shell,
				TMUX: "/tmp/tmux-1000/portikus,1,0",
				TMUX_PANE: "%1",
			},
		});
		let stdout = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, stdout }));
		child.stdin.end(input);
	});
}

test("a shell that exits at once gets the message and a bare shell", async () => {
	const shell = await fakeShell("exit 3");
	const { code, stdout } = await runWrapper(shell, "echo fallback-ran\n");
	expect(stdout).toContain(MESSAGE);
	expect(stdout).toContain("fallback-ran");
	expect(code).toBe(0);
});

test("a shell that runs a while exits with its own status and no message", async () => {
	const shell = await fakeShell("sleep 1.2; exit 7");
	const { code, stdout } = await runWrapper(shell, "");
	expect(stdout).not.toContain(MESSAGE);
	expect(code).toBe(7);
});

test("the shell never sees TMUX or TMUX_PANE", async () => {
	const shell = await fakeShell('echo "tmux=[$TMUX] pane=[$TMUX_PANE]"; sleep 1.1');
	const { stdout } = await runWrapper(shell, "");
	expect(stdout).toContain("tmux=[] pane=[]");
});

test("the login shell is asked to be a login shell", async () => {
	const shell = await fakeShell('echo "args=$*"; sleep 1.1');
	const { stdout } = await runWrapper(shell, "");
	expect(stdout).toContain("args=-l");
});
