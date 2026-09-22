import { spawn } from "node:child_process";
import { lstat, open, stat } from "node:fs/promises";
import {
	GIT_TIMEOUT_MS,
	type GitDiff,
	type GitEntry,
	type GitStatus,
	MAX_DIFF_SIDE_BYTES,
	MAX_GIT_ENTRIES,
} from "@portikus/contracts";
import { resolveInProject } from "./files.js";
import { AgentFailure } from "./tmux.js";

/** How much of a side is sniffed for a NUL byte before it is called binary. */
const SNIFF_BYTES = 8 * 1024;

/** How much git stderr is kept for the debug log. It never reaches a body. */
const STDERR_LIMIT = 2048;

/** Somewhere to put git stderr that is not the response body (STACK.md §15). */
export interface GitDebugLog {
	debug: (details: object, message: string) => void;
}

export interface GitResult {
	ok: boolean;
	stdout: Buffer;
	stderr: string;
	/** The output passed the byte cap and the child was killed. */
	overflow: boolean;
	/** The timer fired and the child was killed. */
	timedOut: boolean;
	/** The exit status, or null when a signal ended the child. */
	exitCode: number | null;
}

/** Kill the whole process group, so any helper git spawned dies with it. */
function killGroup(pid: number | undefined): void {
	if (pid === undefined) return;
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		// The child is already gone, which is the outcome we wanted.
	}
}

/**
 * Run git with argv only, never a shell. Output is capped, so a huge blob
 * cannot be buffered without limit; the child is killed once past the cap.
 */
export async function runGit(
	args: string[],
	cwd: string,
	maxBytes: number,
	timeoutMs: number = GIT_TIMEOUT_MS,
): Promise<GitResult> {
	return new Promise<GitResult>((resolve, reject) => {
		const child = spawn(
			"git",
			// A repository's own config could name a filesystem-monitor command,
			// which git would run during status. Turn it off (SPEC.md §24.6).
			["-c", "core.fsmonitor=", ...args],
			{
				cwd,
				stdio: ["ignore", "pipe", "pipe"],
				// Its own process group, so a kill reaches helpers too.
				detached: true,
				env: {
					...process.env,
					// Reading status must never write the index or ask for a password.
					GIT_OPTIONAL_LOCKS: "0",
					GIT_TERMINAL_PROMPT: "0",
					LC_ALL: "C",
				},
			},
		);
		const chunks: Buffer[] = [];
		let size = 0;
		let overflow = false;
		let timedOut = false;
		let stderr = "";
		let settled = false;

		const timer = setTimeout(() => {
			timedOut = true;
			killGroup(child.pid);
		}, timeoutMs);

		child.stdout.on("data", (chunk: Buffer) => {
			if (overflow) return;
			size += chunk.length;
			if (size > maxBytes) {
				overflow = true;
				killGroup(child.pid);
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
				ok: code === 0 && !overflow && !timedOut,
				stdout: Buffer.concat(chunks),
				stderr: stderr.trim(),
				overflow,
				timedOut,
				exitCode: code,
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
	// Entries and ignored paths share one budget: both travel in the response.
	let budget = MAX_GIT_ENTRIES;
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
			if (budget <= 0) {
				status.truncated = true;
				continue;
			}
			budget -= 1;
			status.ignored.push(record.slice(2));
			continue;
		}

		let entry: GitEntry;
		if (kind === "?") {
			entry = { path: record.slice(2), x: "?", y: "?", unmerged: false };
		} else if (kind === "1") {
			const fields = record.split(" ");
			const xy = fields[1] ?? "..";
			entry = {
				path: fields.slice(8).join(" "),
				x: xy[0] ?? ".",
				y: xy[1] ?? ".",
				unmerged: false,
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
				unmerged: false,
				origPath: records[i] ?? "",
			};
			if (!entry.origPath) delete entry.origPath;
		} else if (kind === "u") {
			const fields = record.split(" ");
			const xy = fields[1] ?? "UU";
			status.conflicts += 1;
			// Every `u` record is a conflict, including both-added (AA) and
			// both-deleted (DD) (SPEC.md §12.8).
			entry = {
				path: fields.slice(10).join(" "),
				x: xy[0] ?? "U",
				y: xy[1] ?? "U",
				unmerged: true,
			};
		} else {
			continue;
		}

		if (budget <= 0) {
			status.truncated = true;
			continue;
		}
		budget -= 1;
		status.entries.push(entry);
	}
	return status;
}

/** The project directory, or a failure if the project is missing. */
async function projectDir(homeDir: string, slug: string): Promise<string> {
	const target = await resolveInProject(homeDir, slug, "", { mustExist: true });
	return target.path;
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

/** Drop the trailing partial record of a truncated NUL-separated stream. */
function completeRecords(text: string): string {
	const end = text.lastIndexOf("\0");
	return end === -1 ? "" : text.slice(0, end + 1);
}

/** Read the repository status for one project (SPEC.md §12.1, §12.8). */
export async function gitStatus(
	homeDir: string,
	slug: string,
	options: { hidden: boolean; log?: GitDebugLog },
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
		// Keep what arrived whole, so the branch line and ahead/behind survive.
		const status = parsePorcelainV2(completeRecords(result.stdout.toString()));
		status.truncated = true;
		return status;
	}
	if (!result.ok) {
		options.log?.debug({ stderr: result.stderr }, "git status failed");
		throw new AgentFailure("GIT_FAILED", "git status failed");
	}
	return parsePorcelainV2(result.stdout.toString());
}

interface Side {
	content: Buffer | null;
	tooLarge: boolean;
}

const MISSING: Side = { content: null, tooLarge: false };

/**
 * Read a blob out of HEAD, capped. A path HEAD does not have reads as null,
 * but only when git said so itself: a killed git is an error, not an add.
 */
export async function showFromHead(
	dir: string,
	path: string,
	options: { log?: GitDebugLog; timeoutMs?: number } = {},
): Promise<Side> {
	const result = await runGit(
		["show", `HEAD:${path}`],
		dir,
		MAX_DIFF_SIDE_BYTES + 1,
		options.timeoutMs,
	);
	if (result.overflow) return { content: null, tooLarge: true };
	if (result.timedOut) {
		throw new AgentFailure("GIT_FAILED", "git timed out");
	}
	if (result.exitCode === null) {
		// A signal ended it. Nothing here says the path is absent from HEAD.
		options.log?.debug({ stderr: result.stderr }, "git show failed");
		throw new AgentFailure("GIT_FAILED", "git show failed");
	}
	if (!result.ok) {
		options.log?.debug({ stderr: result.stderr }, "git show failed");
		return MISSING;
	}
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

interface PathState {
	origPath?: string;
	unmerged: boolean;
}

/**
 * The rename origin and conflict state of one path. Git only reports a rename
 * when it can see both the old and the new path, so there is no pathspec and
 * the whole status is walked once per diff. That walk is the price of rename
 * detection; if it proves slow the UI can pass the old path it already has
 * from the status response, in a later task.
 *
 * The raw records are scanned rather than parsed into entries, so a rename
 * past the entry cap is still found.
 */
async function pathState(dir: string, relPath: string): Promise<PathState> {
	const result = await runGit(
		["status", "--porcelain=v2", "--untracked-files=no", "-z"],
		dir,
		32 * 1024 * 1024,
	);
	const state: PathState = { unmerged: false };
	if (!result.ok) return state;
	const records = completeRecords(result.stdout.toString()).split("\0");
	for (let i = 0; i < records.length; i += 1) {
		const record = records[i];
		if (!record) continue;
		if (record.startsWith("2 ")) {
			const fields = record.split(" ");
			const path = fields.slice(9).join(" ");
			// The original path is the next NUL-separated field.
			i += 1;
			if (path === relPath && records[i]) state.origPath = records[i];
		} else if (record.startsWith("u ")) {
			const fields = record.split(" ");
			if (fields.slice(10).join(" ") === relPath) state.unmerged = true;
		}
	}
	return state;
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
	options: { log?: GitDebugLog } = {},
): Promise<GitDiff> {
	const dir = await projectDir(homeDir, slug);
	const target = await resolveInProject(homeDir, slug, relPath, { mustExist: false });

	// A directory is not a diffable file on either side: git would happily
	// show a tree listing as if it were the file's content.
	// A missing path is fine here: HEAD may still have it.
	const info = await lstat(target.path).catch(() => null);
	if (info && !info.isFile()) {
		throw new AgentFailure("PATH_INVALID", "not a file");
	}

	const repo = await isRepoRoot(dir);
	const state = repo ? await pathState(dir, relPath) : { unmerged: false };
	const origPath = state.origPath;
	const headPath = origPath ?? relPath;

	const hasHead =
		repo && (await runGit(["rev-parse", "--verify", "HEAD"], dir, 4096)).ok;
	if (hasHead) {
		const kind = await runGit(["cat-file", "-t", `HEAD:${headPath}`], dir, 4096);
		if (kind.ok && kind.stdout.toString().trim() !== "blob") {
			throw new AgentFailure("PATH_INVALID", "not a file");
		}
	}
	const before = hasHead ? await showFromHead(dir, headPath, options) : MISSING;
	const after = await readWorkingTree(target.path);
	return finishDiff(before, after, state.unmerged, origPath);
}

const OBJECT_ID = /^[0-9a-f]{40}$/;

/**
 * `git stash create` writes one dangling commit and prints its id. It does
 * not update HEAD, the index, or any ref (SPEC.md §10.9, §12.5, ADR 0019).
 * A directory that is not a work tree, or a command that fails, yields a
 * null object. `baselineHead` is HEAD when there is a commit.
 */
export async function recordBaseline(dir: string): Promise<{
	baselineObjectId: string | null;
	baselineHead: string | null;
}> {
	const head = await runGit(["rev-parse", "--verify", "HEAD"], dir, 128);
	const headId = head.ok ? head.stdout.toString().trim() : "";
	const baselineHead = OBJECT_ID.test(headId) ? headId : null;

	const inside = await runGit(["rev-parse", "--is-inside-work-tree"], dir, 64);
	if (!inside.ok || inside.stdout.toString().trim() !== "true") {
		return { baselineObjectId: null, baselineHead: null };
	}

	const created = await runGit(["stash", "create"], dir, 128);
	if (!created.ok) return { baselineObjectId: null, baselineHead };
	const objectId = created.stdout.toString().trim();
	if (!OBJECT_ID.test(objectId)) return { baselineObjectId: null, baselineHead };
	return { baselineObjectId: objectId, baselineHead };
}

/** One name-status record from `git diff -z`, plus untracked paths. */
function baselineEntries(diffText: string, untrackedText: string): GitEntry[] {
	const entries: GitEntry[] = [];
	const records = diffText.split("\0");
	for (let i = 0; i < records.length; i += 1) {
		const header = records[i];
		if (!header) continue;
		const code = header[0] ?? "M";
		if (code === "R" || code === "C") {
			const origPath = records[i + 1];
			const path = records[i + 2];
			i += 2;
			if (!path || !origPath) continue;
			entries.push({ path, x: ".", y: "R", unmerged: false, origPath });
			continue;
		}
		const path = records[i + 1];
		i += 1;
		if (!path) continue;
		const y = code === "A" || code === "D" || code === "M" ? code : "M";
		entries.push({ path, x: ".", y, unmerged: false });
	}
	for (const path of untrackedText.split("\0")) {
		if (!path) continue;
		entries.push({ path, x: ".", y: "?", unmerged: false });
	}
	return entries;
}

/**
 * Working tree against a session baseline object (SPEC.md §12.7). Branch
 * fields stay empty: this is not `git status`, and it does not move refs.
 */
export async function baselineStatus(
	homeDir: string,
	slug: string,
	objectId: string,
	options: { log?: GitDebugLog } = {},
): Promise<GitStatus> {
	if (!OBJECT_ID.test(objectId)) {
		throw new AgentFailure("BAD_REQUEST", "invalid object");
	}
	const dir = await projectDir(homeDir, slug);
	if (!(await isRepoRoot(dir))) return emptyStatus();
	const kind = await runGit(["cat-file", "-t", objectId], dir, 64);
	if (!kind.ok) {
		options.log?.debug({ stderr: kind.stderr }, "baseline object missing");
		throw new AgentFailure("GIT_FAILED", "baseline object missing");
	}
	const diff = await runGit(
		["diff", "-z", "--no-ext-diff", "--name-status", "--find-renames", objectId],
		dir,
		32 * 1024 * 1024,
	);
	const untracked = await runGit(
		["ls-files", "-z", "--others", "--exclude-standard"],
		dir,
		32 * 1024 * 1024,
	);
	if (diff.timedOut || untracked.timedOut) {
		throw new AgentFailure("GIT_FAILED", "git timed out");
	}
	if (!diff.ok || !untracked.ok) {
		options.log?.debug(
			{ stderr: diff.stderr || untracked.stderr },
			"baseline status failed",
		);
		throw new AgentFailure("GIT_FAILED", "baseline status failed");
	}
	const status = emptyStatus();
	status.repo = true;
	const all = baselineEntries(diff.stdout.toString(), untracked.stdout.toString());
	status.entries = all.slice(0, MAX_GIT_ENTRIES);
	status.truncated =
		diff.overflow || untracked.overflow || all.length > MAX_GIT_ENTRIES;
	return status;
}

/** Where a path sits relative to the baseline object, including a rename. */
async function baselinePathState(
	dir: string,
	objectId: string,
	relPath: string,
): Promise<PathState> {
	const result = await runGit(
		["diff", "-z", "--no-ext-diff", "--name-status", "--find-renames", objectId],
		dir,
		32 * 1024 * 1024,
	);
	const state: PathState = { unmerged: false };
	if (!result.ok) return state;
	for (const entry of baselineEntries(result.stdout.toString(), "")) {
		if (entry.path === relPath && entry.origPath) state.origPath = entry.origPath;
	}
	return state;
}

/**
 * One file against the session baseline object (SPEC.md §12.7). Same size
 * and binary limits as the Git diff.
 */
export async function baselineDiff(
	homeDir: string,
	slug: string,
	objectId: string,
	relPath: string,
	options: { log?: GitDebugLog } = {},
): Promise<GitDiff> {
	if (!OBJECT_ID.test(objectId)) {
		throw new AgentFailure("BAD_REQUEST", "invalid object");
	}
	const dir = await projectDir(homeDir, slug);
	const target = await resolveInProject(homeDir, slug, relPath, { mustExist: false });
	const info = await lstat(target.path).catch(() => null);
	if (info && !info.isFile()) {
		throw new AgentFailure("PATH_INVALID", "not a file");
	}

	const repo = await isRepoRoot(dir);
	const state = repo
		? await baselinePathState(dir, objectId, relPath)
		: { unmerged: false };
	const origPath = state.origPath;
	const beforePath = origPath ?? relPath;
	const kind = await runGit(["cat-file", "-t", `${objectId}:${beforePath}`], dir, 64);
	if (kind.ok && kind.stdout.toString().trim() !== "blob") {
		throw new AgentFailure("PATH_INVALID", "not a file");
	}
	const before = kind.ok
		? await showFromRev(dir, objectId, beforePath, options)
		: MISSING;
	const after = await readWorkingTree(target.path);
	return finishDiff(before, after, false, origPath);
}

/** Read a blob out of an arbitrary object, with the same cap as HEAD. */
async function showFromRev(
	dir: string,
	rev: string,
	path: string,
	options: { log?: GitDebugLog },
): Promise<Side> {
	const result = await runGit(["show", `${rev}:${path}`], dir, MAX_DIFF_SIDE_BYTES + 1);
	if (result.overflow) return { content: null, tooLarge: true };
	if (result.timedOut || result.exitCode === null) {
		options.log?.debug({ stderr: result.stderr }, "git show failed");
		throw new AgentFailure("GIT_FAILED", "git show failed");
	}
	if (!result.ok) return MISSING;
	if (result.stdout.length > MAX_DIFF_SIDE_BYTES) {
		return { content: null, tooLarge: true };
	}
	return { content: result.stdout, tooLarge: false };
}

function finishDiff(
	before: Side,
	after: Side,
	unmerged: boolean,
	origPath: string | undefined,
): GitDiff {
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
