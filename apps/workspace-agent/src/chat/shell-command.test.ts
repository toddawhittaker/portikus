import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	bashInputText,
	bashOutputText,
	parseBashInput,
	parseBashOutput,
	runShellCommand,
	shellTranscript,
} from "./shell-command.js";

/** A `!` command runs as the student, in the project, within limits (ADR 0073). */

let dir: string;
beforeEach(async () => {
	dir = await realpath(await mkdtemp(join(tmpdir(), "pk-shell-")));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("running a command", () => {
	test("it runs in the project folder and keeps stdout and stderr in arrival order", async () => {
		const run = await runShellCommand("pwd; echo out; echo err >&2; echo again", {
			cwd: dir,
			shell: "/bin/bash",
		});
		expect(run).toEqual({
			output: `${dir}\nout\nerr\nagain\n`,
			exitCode: 0,
			truncated: false,
			timedOut: false,
		});
	});

	test("a failing command reports its exit code", async () => {
		const run = await runShellCommand("exit 3", { cwd: dir, shell: "/bin/bash" });
		expect(run.exitCode).toBe(3);
	});

	test("output past the cap is cut and marked, and the command still finishes", async () => {
		const run = await runShellCommand(
			"head -c 5000 /dev/zero | tr '\\0' x; echo; exit 0",
			{
				cwd: dir,
				shell: "/bin/bash",
				maxChars: 100,
			},
		);
		expect(run.output).toBe("x".repeat(100));
		expect(run.truncated).toBe(true);
		expect(run.exitCode).toBe(0);
	});

	test("a command past the time limit is killed with its whole process group", async () => {
		const marker = join(dir, "survived");
		const started = Date.now();
		const run = await runShellCommand(
			`echo begun; (sleep 2; touch ${marker}) & sleep 30`,
			{
				cwd: dir,
				shell: "/bin/bash",
				timeoutMs: 300,
			},
		);
		expect(Date.now() - started).toBeLessThan(5000);
		expect(run).toMatchObject({ output: "begun\n", exitCode: null, timedOut: true });
		await new Promise((resolve) => setTimeout(resolve, 2500));
		expect(existsSync(marker)).toBe(false);
	});

	test("a background job left running does not hold the command open", async () => {
		const started = Date.now();
		const run = await runShellCommand("sleep 30 & echo done", {
			cwd: dir,
			shell: "/bin/bash",
			timeoutMs: 10_000,
		});
		expect(Date.now() - started).toBeLessThan(5000);
		expect(run).toMatchObject({ output: "done\n", exitCode: 0, timedOut: false });
	});

	test("a shell that cannot start is reported, not thrown", async () => {
		const run = await runShellCommand("true", {
			cwd: dir,
			shell: join(dir, "no-shell"),
		});
		expect(run.exitCode).toBeNull();
		expect(run.output).toContain("could not start");
	});
});

describe("the transcript form", () => {
	test("a command and its output read back as they were", () => {
		expect(parseBashInput(bashInputText("ls -la"))).toBe("ls -la");
		const ok = { output: "a\n", exitCode: 0, truncated: false, timedOut: false };
		expect(parseBashOutput(bashOutputText(ok))).toEqual({
			output: "a\n",
			exitCode: 0,
			truncated: false,
		});
		const failed = { output: "", exitCode: 2, truncated: true, timedOut: false };
		expect(bashOutputText(failed)).toContain("Exit code 2");
		expect(parseBashOutput(bashOutputText(failed))).toEqual({
			output: "",
			exitCode: 2,
			truncated: true,
		});
		const stopped = { output: "x", exitCode: null, truncated: false, timedOut: true };
		expect(parseBashOutput(bashOutputText(stopped))).toMatchObject({ exitCode: null });
	});

	test("Claude Code's own bash-mode stderr is shown with the output", () => {
		expect(
			parseBashOutput(
				"<bash-stdout>a\n</bash-stdout><bash-stderr>oops\n</bash-stderr>",
			),
		).toEqual({ output: "a\noops\n", exitCode: 0, truncated: false });
	});

	test("ordinary text is neither", () => {
		expect(parseBashInput("hello")).toBeNull();
		expect(parseBashOutput("<bash-stdout>x</bash-stdout>")).toBeNull();
	});

	test("both appends start no turn, and the command keeps the item's id", () => {
		const [input, output] = shellTranscript("id-1", "ls", {
			output: "",
			exitCode: 0,
			truncated: false,
			timedOut: false,
		});
		expect(input).toMatchObject({
			uuid: "id-1",
			shouldQuery: false,
			parent_tool_use_id: null,
			message: { role: "user", content: "<bash-input>ls</bash-input>" },
		});
		expect(output?.shouldQuery).toBe(false);
		expect(output?.uuid).not.toBe("id-1");
	});
});
