import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
	type ChatShellItem,
	MAX_CHAT_SHELL_COMMAND_CHARS,
	MAX_CHAT_SHELL_OUTPUT_CHARS,
} from "@portikus/contracts";

/** How long a `!` command may run before its process group is killed (ADR 0073). */
const SHELL_TIME_LIMIT_MS = 2 * 60 * 1000;
/** How long output may still drain after the shell exits. */
const EXIT_GRACE_MS = 500;

/**
 * Why the host will not run this command now, or null. One thing runs at a
 * time, so a command never lands in the middle of Claude's work (ADR 0073).
 */
export function shellRefusal(
	command: string,
	attachments: number,
	turnRunning: boolean,
): string | null {
	if (turnRunning)
		return "A shell command cannot run while Claude is working. Wait, or stop it first.";
	if (attachments > 0) return "A shell command cannot carry attachments.";
	if (command.length > MAX_CHAT_SHELL_COMMAND_CHARS)
		return "That shell command is too long.";
	return null;
}

export function runningShell(id: string, command: string): ChatShellItem {
	return {
		kind: "shell",
		id,
		command,
		output: "",
		exitCode: null,
		truncated: false,
		state: "running",
	};
}

export interface ShellRun {
	/** Standard output and standard error, interleaved in arrival order. */
	output: string;
	/** Null when the command was killed or could not start. */
	exitCode: number | null;
	truncated: boolean;
	timedOut: boolean;
}

export interface ShellRunOptions {
	cwd: string;
	/** The student's login shell; it is run as `<shell> -lc <command>`. */
	shell?: string;
	timeoutMs?: number;
	maxChars?: number;
}

/**
 * Run one `!` command as the student, in the project folder, the way the
 * student's own terminal would (ADR 0073). Output past the cap is read and
 * dropped so the command is not stalled on a full pipe.
 */
export function runShellCommand(
	command: string,
	options: ShellRunOptions,
): Promise<ShellRun> {
	const maxChars = options.maxChars ?? MAX_CHAT_SHELL_OUTPUT_CHARS;
	const shell = options.shell || process.env.SHELL || "/bin/bash";
	return new Promise((resolve) => {
		let output = "";
		let truncated = false;
		let timedOut = false;
		// One pipe for both streams keeps them in the order they were written.
		const child = spawn(shell, ["-lc", `exec 2>&1\n${command}`], {
			cwd: options.cwd,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const take = (chunk: string) => {
			if (truncated) return;
			const room = maxChars - output.length;
			if (chunk.length > room) {
				output += chunk.slice(0, room);
				truncated = true;
			} else {
				output += chunk;
			}
		};
		child.stdout.setEncoding("utf8").on("data", take);
		child.stderr.setEncoding("utf8").on("data", take);
		let settled = false;
		let exitCode: number | null = null;
		const settle = (run: ShellRun) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(run);
		};
		// A process that left the group (setsid) may still hold the pipe, so
		// completion is the shell's exit plus a short grace, not the pipe's close.
		const finish = () => {
			setTimeout(() => {
				child.stdout.destroy();
				child.stderr.destroy();
				settle({ output, exitCode: timedOut ? null : exitCode, truncated, timedOut });
			}, EXIT_GRACE_MS);
		};
		const timer = setTimeout(() => {
			timedOut = true;
			killGroup(child.pid);
		}, options.timeoutMs ?? SHELL_TIME_LIMIT_MS);
		child.once("error", (error: NodeJS.ErrnoException) => {
			settle({
				output: `The shell could not start (${error.code ?? "error"}).`,
				exitCode: null,
				truncated: false,
				timedOut: false,
			});
		});
		child.once("exit", (code) => {
			exitCode = code;
			// A background job the command left behind dies with it.
			killGroup(child.pid);
			finish();
		});
		child.once("close", () =>
			settle({ output, exitCode: timedOut ? null : exitCode, truncated, timedOut }),
		);
	});
}

function killGroup(pid: number | undefined): void {
	if (pid === undefined) return;
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		// Already gone.
	}
}

/*
 * The transcript form Claude Code itself writes for bash mode, so Claude
 * reads the command and its output with the next message. The note in
 * `<bash-stderr>` carries what the output alone does not say.
 */
const INPUT = /^<bash-input>([\s\S]*)<\/bash-input>$/;
const OUTPUT =
	/^<bash-stdout>([\s\S]*)<\/bash-stdout><bash-stderr>([\s\S]*)<\/bash-stderr>$/;
const EXIT_NOTE = /^Exit code (\d+)$/m;
const STOPPED_NOTE = "Stopped: the command ran past the time limit.";
const CUT_NOTE = "The output was cut at the size limit.";

export function bashInputText(command: string): string {
	return `<bash-input>${command}</bash-input>`;
}

export function bashOutputText(run: ShellRun): string {
	const notes: string[] = [];
	if (run.timedOut) notes.push(STOPPED_NOTE);
	else if (run.exitCode !== 0 && run.exitCode !== null)
		notes.push(`Exit code ${run.exitCode}`);
	if (run.truncated) notes.push(CUT_NOTE);
	return `<bash-stdout>${run.output}</bash-stdout><bash-stderr>${notes.join("\n")}</bash-stderr>`;
}

/**
 * The command and its output as two transcript appends that start no turn;
 * the command's entry keeps the shell item's id, for replay.
 */
export function shellTranscript(
	id: string,
	command: string,
	run: ShellRun,
): SDKUserMessage[] {
	const append = (uuid: string, content: string) =>
		({
			type: "user",
			message: { role: "user", content },
			parent_tool_use_id: null,
			uuid,
			shouldQuery: false,
		}) as SDKUserMessage;
	return [
		append(id, bashInputText(command)),
		append(randomUUID(), bashOutputText(run)),
	];
}

/** The command in a bash-mode input entry, else null. */
export function parseBashInput(text: string): string | null {
	return INPUT.exec(text)?.[1] ?? null;
}

/** A bash-mode output entry read back, else null. */
export function parseBashOutput(
	text: string,
): { output: string; exitCode: number | null; truncated: boolean } | null {
	const match = OUTPUT.exec(text);
	if (!match) return null;
	const stdout = match[1] ?? "";
	const stderr = match[2] ?? "";
	const exit = EXIT_NOTE.exec(stderr);
	const own = exit || stderr.includes(STOPPED_NOTE) || stderr.includes(CUT_NOTE);
	return {
		// Claude Code's own bash mode keeps real stderr here; show it with the output.
		output: own || stderr === "" ? stdout : `${stdout}${stderr}`,
		exitCode: stderr.includes(STOPPED_NOTE) ? null : exit ? Number(exit[1]) : 0,
		truncated: stderr.includes(CUT_NOTE),
	};
}

/** A shell item as the fields of its `shell` event. */
export function withoutKind({ kind: _kind, ...fields }: ChatShellItem) {
	return fields;
}
