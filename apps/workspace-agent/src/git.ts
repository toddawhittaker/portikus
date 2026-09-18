import { spawn } from "node:child_process";
import { open, stat } from "node:fs/promises";
import {
	type GitDiff,
	type GitEntry,
	type GitStatus,
	MAX_DIFF_SIDE_BYTES,
	MAX_GIT_ENTRIES,
} from "@portikus/contracts";
import { resolveInProject } from "./files.js";
import { AgentFailure } from "./tmux.js";

/** Reading Git state happens inside a request, so keep it short. */
const GIT_TIMEOUT_MS = 10_000;

/** How much of a side is sniffed for a NUL byte before it is called binary. */
const SNIFF_BYTES = 8 * 1024;

/** How much git stderr travels back to the student. */
const STDERR_LIMIT = 2048;

interface GitResult {
	ok: boolean;
	stdout: Buffer;
	stderr: string;
	/** The output passed the byte cap and the child was killed. */
	overflow: boolean;
}

/**
 * Run git with argv only, never a shell. Output is capped, so a huge blob
 * cannot be buffered without limit; the child is killed once past the cap.
 */
async function runGit(
	args: string[],
	cwd: string,
	maxBytes: number,
): Promise<GitResult> {
	return new Promise<GitResult>((resolve, reject) => {
		const child = spawn("git", args, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				// Reading status must never write the index or ask for a password.
				GIT_OPTIONAL_LOCKS: "0",
				GIT_TERMINAL_PROMPT: "0",
				LC_ALL: "C",
			},
		});
		const chunks: Buffer[] = [];
		let size = 0;
		let overflow = false;
		let stderr = "";
		let settled = false;

		const timer = setTimeout(() => {
			child.kill("SIGKILL");
		}, GIT_TIMEOUT_MS);

		child.stdout.on("data", (chunk: Buffer) => {
			if (overflow) return;
			size += chunk.length;
			if (size > maxBytes) {
				overflow = true;
				child.kill("SIGKILL");
				return;
			}
			chunks.push(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = (stderr + chunk.toString()).slice(-STDERR_LIMIT);
		});
		child.on("error", (error: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(new AgentFailure("GIT_FAILED", `could not run git: ${error.message}`));
		});
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({
				ok: code === 0 && !overflow,
				stdout: Buffer.concat(chunks),
				stderr: stderr.trim(),
				overflow,
			});
		});
	});
}

function emptyStatus(): GitStatus {
	return {
		repo: false,
		branch: null,
		detached: false,
		upstream: null,
		ahead: 0,
		behind: 0,
		conflicts: 0,
		entries: [],
		ignored: [],
		truncated: false,
	};
}

/**
 * Parse `git status --porcelain=v2 --branch -z` output. NUL-separated, so a
 * path with a space or a newline in it survives. A rename record carries two
 * paths: the new one, then the original (SPEC.md §12.1, §12.8).
 */
export function parsePorcelainV2(text: string): GitStatus {
	const status = emptyStatus();
	status.repo = true;
	const records = text.split("\0");
	for (let i = 0; i < records.length; i += 1) {
		const record = records[i];
		if (!record) continue;
		const kind = record[0];

		if (kind === "#") {
			const [, key, ...rest] = record.split(" ");
			const value = rest.join(" ");
			if (key === "branch.head") {
				if (value === "(detached)") {
					status.detached = true;
				} else {
					status.branch = value;
				}
			} else if (key === "branch.upstream") {
				status.upstream = value;
			} else if (key === "branch.ab") {
				const [ahead, behind] = value.split(" ");
				status.ahead = Number.parseInt(ahead?.replace("+", "") ?? "0", 10) || 0;
				status.behind = Number.parseInt(behind?.replace("-", "") ?? "0", 10) || 0;
			}
			continue;
		}

		if (kind === "!") {
			status.ignored.push(record.slice(2));
			continue;
		}

		let entry: GitEntry;
		if (kind === "?") {
			entry = { path: record.slice(2), x: "?", y: "?" };
		} else if (kind === "1") {
			const fields = record.split(" ");
			const xy = fields[1] ?? "..";
			entry = {
				path: fields.slice(8).join(" "),
				x: xy[0] ?? ".",
				y: xy[1] ?? ".",
			};
		} else if (kind === "2") {
			const fields = record.split(" ");
			const xy = fields[1] ?? "..";
			// The original path is the next NUL-separated field.
			i += 1;
			entry = {
				path: fields.slice(9).join(" "),
				x: xy[0] ?? ".",
				y: xy[1] ?? ".",
				origPath: records[i] ?? "",
			};
			if (!entry.origPath) delete entry.origPath;
		} else if (kind === "u") {
			const fields = record.split(" ");
			const xy = fields[1] ?? "UU";
			status.conflicts += 1;
			entry = {
				path: fields.slice(10).join(" "),
				x: xy[0] ?? "U",
				y: xy[1] ?? "U",
			};
		} else {
			continue;
		}

		if (status.entries.length >= MAX_GIT_ENTRIES) {
			status.truncated = true;
			continue;
		}
		status.entries.push(entry);
	}
	return status;
}

/** The project directory, or a failure if the project is missing. */
async function projectDir(homeDir: string, slug: string): Promise<string> {
	const target = await resolveInProject(homeDir, slug, "", { mustExist: true });
	return target.root;
}

/**
 * True when `dir` is itself the top of a work tree. A project sitting inside
 * some other repository must not report that repository's status.
 */
async function isRepoRoot(dir: string): Promise<boolean> {
	const result = await runGit(["rev-parse", "--show-toplevel"], dir, 64 * 1024);
	if (!result.ok) return false;
	const top = result.stdout.toString().trim();
	return top === dir;
}

/** Read the repository status for one project (SPEC.md §12.1, §12.8). */
export async function gitStatus(
	homeDir: string,
	slug: string,
	options: { hidden: boolean },
): Promise<GitStatus> {
	const dir = await projectDir(homeDir, slug);
	if (!(await isRepoRoot(dir))) {
		return emptyStatus();
	}
	const args = ["status", "--porcelain=v2", "--branch", "--untracked-files=all", "-z"];
	if (options.hidden) args.push("--ignored=matching");
	// A capped read is enough: past the cap the list is truncated anyway.
	const result = await runGit(args, dir, 32 * 1024 * 1024);
	if (result.overflow) {
		const status = emptyStatus();
		status.repo = true;
		status.truncated = true;
		return status;
	}
	if (!result.ok) {
		throw new AgentFailure("GIT_FAILED", result.stderr || "git status failed");
	}
	return parsePorcelainV2(result.stdout.toString());
}

interface Side {
	content: Buffer | null;
	tooLarge: boolean;
}

const MISSING: Side = { content: null, tooLarge: false };

/** Read a blob out of HEAD, capped. A path HEAD does not have reads as null. */
async function showFromHead(dir: string, path: string): Promise<Side> {
	const result = await runGit(["show", `HEAD:${path}`], dir, MAX_DIFF_SIDE_BYTES + 1);
	if (result.overflow) return { content: null, tooLarge: true };
	if (!result.ok) return MISSING;
	if (result.stdout.length > MAX_DIFF_SIDE_BYTES) {
		return { content: null, tooLarge: true };
	}
	return { content: result.stdout, tooLarge: false };
}

/** Read the working-tree side, capped the same way. */
async function readWorkingTree(path: string): Promise<Side> {
	let info: Awaited<ReturnType<typeof stat>>;
	try {
		info = await stat(path);
	} catch {
		return MISSING;
	}
	if (!info.isFile()) return MISSING;
	if (info.size > MAX_DIFF_SIDE_BYTES) return { content: null, tooLarge: true };
	const handle = await open(path, "r");
	try {
		return { content: await handle.readFile(), tooLarge: false };
	} finally {
		await handle.close();
	}
}

function isBinary(side: Side): boolean {
	return side.content?.subarray(0, SNIFF_BYTES).includes(0) ?? false;
}

/**
 * The HEAD version of a file against its working-tree version (SPEC.md §12.6).
 * Read-only: this never commits, adds, stashes, checks out, branches or tags
 * (SPEC.md §12.5).
 */
export async function gitDiff(
	homeDir: string,
	slug: string,
	relPath: string,
): Promise<GitDiff> {
	if (relPath === "") {
		throw new AgentFailure("PATH_INVALID", "a diff needs a file path");
	}
	const target = await resolveInProject(homeDir, slug, relPath, { mustExist: false });
	const dir = target.root;
	const repo = await isRepoRoot(dir);

	let origPath: string | undefined;
	let unmerged = false;
	if (repo) {
		// No pathspec: Git only reports a rename when it can see both paths.
		const result = await runGit(
			["status", "--porcelain=v2", "--untracked-files=no", "-z"],
			dir,
			32 * 1024 * 1024,
		);
		if (result.ok) {
			const text = result.stdout.toString();
			origPath = parsePorcelainV2(text).entries.find(
				(candidate) => candidate.path === relPath,
			)?.origPath;
			// An unmerged record is the only place Git records a conflict.
			unmerged = text
				.split("\0")
				.some(
					(record) =>
						record.startsWith("u ") &&
						record.split(" ").slice(10).join(" ") === relPath,
				);
		}
	}

	const hasHead =
		repo && (await runGit(["rev-parse", "--verify", "HEAD"], dir, 4096)).ok;
	const before = hasHead ? await showFromHead(dir, origPath ?? relPath) : MISSING;
	const after = await readWorkingTree(target.path);

	const tooLarge = before.tooLarge || after.tooLarge;
	const binary = !tooLarge && (isBinary(before) || isBinary(after));

	let status: GitDiff["status"];
	if (unmerged) status = "U";
	else if (origPath) status = "R";
	else if (before.content === null && !before.tooLarge) status = "A";
	else if (after.content === null && !after.tooLarge) status = "D";
	else status = "M";

	const hide = tooLarge || binary;
	return {
		status,
		...(origPath ? { oldPath: origPath } : {}),
		before: hide || before.content === null ? null : before.content.toString("utf8"),
		after: hide || after.content === null ? null : after.content.toString("utf8"),
		binary,
		tooLarge,
	};
}
