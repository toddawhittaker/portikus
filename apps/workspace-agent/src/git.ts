import { spawn } from "node:child_process";
import type { Dirent } from "node:fs";
import { lstat, mkdtemp, open, readdir, readlink, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
	options: {
		config?: readonly string[];
		env?: Readonly<Record<string, string>>;
		/** Exact stdin bytes. Used to hash a symlink target without following it. */
		input?: Buffer;
	} = {},
): Promise<GitResult> {
	// A repository config could name a filesystem monitor. Turn it off (SPEC.md §24.6).
	const configArgs: string[] = ["-c", "core.fsmonitor="];
	for (const item of options.config ?? []) {
		configArgs.push("-c", item);
	}
	return new Promise<GitResult>((resolve, reject) => {
		const child = spawn("git", [...configArgs, ...args], {
			cwd,
			stdio: [options.input ? "pipe" : "ignore", "pipe", "pipe"],
			// Its own process group, so a kill reaches helpers too.
			detached: true,
			env: {
				...process.env,
				// Reading status must never write the index or ask for a password.
				GIT_OPTIONAL_LOCKS: "0",
				GIT_TERMINAL_PROMPT: "0",
				LC_ALL: "C",
				...options.env,
			},
		});
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

		const stdout = child.stdout;
		const stderrStream = child.stderr;
		if (!stdout || !stderrStream) {
			settled = true;
			clearTimeout(timer);
			killGroup(child.pid);
			reject(new AgentFailure("GIT_FAILED", "could not run git"));
			return;
		}
		if (options.input) {
			const stdin = child.stdin;
			if (!stdin) {
				settled = true;
				clearTimeout(timer);
				killGroup(child.pid);
				reject(new AgentFailure("GIT_FAILED", "could not run git"));
				return;
			}
			stdin.on("error", () => {});
			stdin.end(options.input);
		}

		stdout.on("data", (chunk: Buffer) => {
			if (overflow) return;
			size += chunk.length;
			if (size > maxBytes) {
				overflow = true;
				killGroup(child.pid);
				return;
			}
			chunks.push(chunk);
		});
		stderrStream.on("data", (chunk: Buffer) => {
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

/** A full object id: SHA-1 is 40 hex characters, SHA-256 is 64. */
export const OBJECT_ID = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

/** Directories that must not be copied into the baseline object. */
const BASELINE_SKIP = new Set(["node_modules", ".git", "dist", ".next"]);

/** Identity for the dangling baseline commit only. Never written to git config. */
const BASELINE_IDENTITY = {
	GIT_AUTHOR_NAME: "Portikus",
	GIT_AUTHOR_EMAIL: "portikus@localhost",
	GIT_COMMITTER_NAME: "Portikus",
	GIT_COMMITTER_EMAIL: "portikus@localhost",
};

/**
 * `git stash create` writes one dangling commit and prints its id. It does
 * not update HEAD, the index, or any ref (SPEC.md §10.9, §12.5, ADR 0019).
 * On a clean tree it prints nothing, so the baseline is HEAD. Untracked
 * files and root `.env` files ride along as a parentless second parent,
 * because `stash create -u` does not record them on Git 2.43. A directory
 * that is not a work tree, or a command that fails, yields a null object.
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

	// A failed listing must not fall through to stash with filters still on.
	const config = await contentFilterOverrides(dir);
	if (!config) return { baselineObjectId: null, baselineHead };
	const created = await runGit(["stash", "create"], dir, 128, GIT_TIMEOUT_MS, {
		config,
	});
	if (!created.ok) return { baselineObjectId: null, baselineHead };
	const printed = created.stdout.toString().trim();
	const objectId = printed === "" ? (baselineHead ?? "") : printed;
	if (!OBJECT_ID.test(objectId)) return { baselineObjectId: null, baselineHead };
	const withExtras = await attachUntracked(dir, objectId);
	return { baselineObjectId: withExtras, baselineHead };
}

/**
 * This invocation only. A content filter can run `git update-ref`, which
 * would move a branch (SPEC.md §10.9). Git runs `filter.<name>.process`
 * even when clean and smudge are blank, and the name may contain `_` or
 * `.`. Empty `-c` values override repo config without writing it.
 * `core.hooksPath` points at `/dev/null`.
 *
 * Null means fail closed: the listing failed, its output was past the read
 * cap, or a name cannot be overridden safely. Callers must not run a
 * command that applies filters.
 */
async function contentFilterOverrides(dir: string): Promise<string[] | null> {
	const listed = await runGit(["config", "--get-regexp", "^filter\\."], dir, 64 * 1024);
	// Exit 1 with an empty body means there are no filter keys. Any other
	// failure, including a killed read past the cap, is not a usable list.
	const noFilters =
		listed.exitCode === 1 &&
		listed.stdout.length === 0 &&
		!listed.overflow &&
		!listed.timedOut;
	if (!listed.ok && !noFilters) return null;
	const names = new Set<string>();
	for (const line of listed.stdout.toString().split("\n")) {
		const key = line.split(/[ \t]/, 1)[0] ?? "";
		const match = /^filter\.(.*)\.(clean|smudge|process)$/i.exec(key);
		if (!match) continue;
		const name = match[1];
		// `git -c` splits on the first `=`, so such a name cannot be blanked.
		if (!name || /[\s=]/.test(name)) return null;
		names.add(name);
	}
	const config = ["core.hooksPath=/dev/null"];
	for (const name of names) {
		config.push(
			`filter.${name}.clean=`,
			`filter.${name}.smudge=`,
			`filter.${name}.process=`,
		);
	}
	return config;
}

function skippedBaselinePath(path: string): boolean {
	return path.split("/").some((segment) => BASELINE_SKIP.has(segment));
}

/** Untracked files Git already knows to show, plus root `.env` and `.env.*`. */
async function extraBaselinePaths(dir: string): Promise<string[]> {
	const listed = await runGit(
		["ls-files", "-z", "--others", "--exclude-standard"],
		dir,
		32 * 1024 * 1024,
	);
	const paths: string[] = [];
	if (listed.ok) {
		for (const path of listed.stdout.toString("utf8").split("\0")) {
			if (!path || path.includes("\n") || skippedBaselinePath(path)) continue;
			paths.push(path);
		}
	}
	let entries: Dirent[] = [];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return paths;
	}
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		if (!/^\.env(\..+)?$/.test(entry.name)) continue;
		if (paths.includes(entry.name)) continue;
		// A committed `.env.example` is already in the commit tree.
		if (await trackedPath(dir, entry.name)) continue;
		paths.push(entry.name);
	}
	return paths;
}

/**
 * A parentless commit whose tree is only the extra files. The baseline
 * commit keeps the tracked tree and points at this as its second parent.
 * No ref is updated.
 */
async function attachUntracked(dir: string, base: string): Promise<string> {
	const paths = await extraBaselinePaths(dir);
	if (paths.length === 0) return base;
	const indexDir = await mkdtemp(join(tmpdir(), "portikus-baseline-"));
	const indexPath = join(indexDir, "index");
	try {
		const blobs: { path: string; oid: string; mode: string }[] = [];
		for (const path of paths) {
			const full = join(dir, path);
			const info = await lstat(full).catch(() => null);
			if (!info) continue;
			let oid = "";
			let mode = "";
			if (info.isSymbolicLink()) {
				// The blob is the link text. Hashing the path would follow it.
				const target = await readlink(full).catch(() => null);
				if (target === null) continue;
				oid = (await hashStdin(dir, target, true)) ?? "";
				mode = "120000";
			} else if (info.isFile()) {
				const hashed = await runGit(
					["hash-object", "-w", "--no-filters", "--", path],
					dir,
					128,
				);
				oid = hashed.ok ? hashed.stdout.toString().trim() : "";
				mode = info.mode & 0o111 ? "100755" : "100644";
			} else {
				continue;
			}
			if (!OBJECT_ID.test(oid)) continue;
			blobs.push({ path, oid, mode });
		}
		if (blobs.length === 0) return base;
		const empty = await runGit(["read-tree", "--empty"], dir, 64, GIT_TIMEOUT_MS, {
			env: { GIT_INDEX_FILE: indexPath },
		});
		if (!empty.ok) return base;
		for (const blob of blobs) {
			const added = await runGit(
				[
					"update-index",
					"--add",
					"--cacheinfo",
					`${blob.mode},${blob.oid},${blob.path}`,
				],
				dir,
				64,
				GIT_TIMEOUT_MS,
				{ env: { GIT_INDEX_FILE: indexPath } },
			);
			if (!added.ok) return base;
		}
		const tree = await runGit(["write-tree"], dir, 128, GIT_TIMEOUT_MS, {
			env: { GIT_INDEX_FILE: indexPath },
		});
		const treeId = tree.ok ? tree.stdout.toString().trim() : "";
		if (!OBJECT_ID.test(treeId)) return base;
		const side = await runGit(
			["commit-tree", treeId, "-m", "baseline untracked"],
			dir,
			128,
			GIT_TIMEOUT_MS,
			{ env: BASELINE_IDENTITY },
		);
		const sideId = side.ok ? side.stdout.toString().trim() : "";
		if (!OBJECT_ID.test(sideId)) return base;
		const baseTree = await runGit(
			["rev-parse", "--verify", `${base}^{tree}`],
			dir,
			128,
		);
		const baseTreeId = baseTree.ok ? baseTree.stdout.toString().trim() : "";
		if (!OBJECT_ID.test(baseTreeId)) return base;
		const wrapped = await runGit(
			["commit-tree", baseTreeId, "-p", base, "-p", sideId, "-m", "baseline"],
			dir,
			128,
			GIT_TIMEOUT_MS,
			{ env: BASELINE_IDENTITY },
		);
		const wrappedId = wrapped.ok ? wrapped.stdout.toString().trim() : "";
		return OBJECT_ID.test(wrappedId) ? wrappedId : base;
	} finally {
		await rm(indexDir, { recursive: true, force: true });
	}
}

/**
 * The parentless second parent, when this baseline recorded extra files.
 * A stash commit's second parent has its own parent, so it is left alone.
 */
async function untrackedSide(
	dir: string,
	objectId: string,
): Promise<Map<string, string>> {
	const side = await runGit(
		["rev-parse", "--verify", "--quiet", `${objectId}^2`],
		dir,
		128,
	);
	const sideId = side.ok ? side.stdout.toString().trim() : "";
	if (!OBJECT_ID.test(sideId)) return new Map();
	const parent = await runGit(
		["rev-parse", "--verify", "--quiet", `${sideId}^`],
		dir,
		128,
	);
	if (parent.ok && OBJECT_ID.test(parent.stdout.toString().trim())) return new Map();
	const listed = await runGit(["ls-tree", "-r", "-z", sideId], dir, 32 * 1024 * 1024);
	if (!listed.ok) return new Map();
	const map = new Map<string, string>();
	for (const record of listed.stdout.toString("utf8").split("\0")) {
		if (!record) continue;
		const tab = record.indexOf("\t");
		if (tab === -1) continue;
		const meta = record.slice(0, tab).split(" ");
		const oid = meta[2] ?? "";
		const path = record.slice(tab + 1);
		if (!OBJECT_ID.test(oid) || !path) continue;
		map.set(path, oid);
	}
	return map;
}

/** True when the path is already in the index, so Git will report it itself. */
async function trackedPath(dir: string, path: string): Promise<boolean> {
	const listed = await runGit(["ls-files", "-z", "--", path], dir, 8192);
	if (!listed.ok) return false;
	return listed.stdout.toString("utf8").split("\0").includes(path);
}

/** Hash exact bytes. `write` stores the blob in the repository. */
async function hashStdin(
	dir: string,
	bytes: string,
	write: boolean,
): Promise<string | null> {
	const args = write
		? ["hash-object", "-w", "--stdin", "--no-filters"]
		: ["hash-object", "--stdin", "--no-filters"];
	const hashed = await runGit(args, dir, 128, GIT_TIMEOUT_MS, {
		input: Buffer.from(bytes),
	});
	const oid = hashed.ok ? hashed.stdout.toString().trim() : "";
	return OBJECT_ID.test(oid) ? oid : null;
}

async function hashWorktree(dir: string, path: string): Promise<string | null> {
	const full = join(dir, path);
	const info = await lstat(full).catch(() => null);
	if (!info) return null;
	if (info.isSymbolicLink()) {
		const target = await readlink(full).catch(() => null);
		if (target === null) return null;
		return hashStdin(dir, target, false);
	}
	if (!info.isFile()) return null;
	const hashed = await runGit(["hash-object", "--no-filters", "--", path], dir, 128);
	const oid = hashed.ok ? hashed.stdout.toString().trim() : "";
	return OBJECT_ID.test(oid) ? oid : null;
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

/** `node_modules`, `.git`, `dist`, and `.next` are not session additions. */
function dropSkipped(untrackedText: string): string {
	const kept = untrackedText
		.split("\0")
		.filter((path) => path.length > 0 && !skippedBaselinePath(path));
	return kept.length === 0 ? "" : `${kept.join("\0")}\0`;
}

/** Paths already appended by `git ls-files` stay; root `.env` files join them. */
function mergeExtraPaths(untrackedText: string, extras: string[]): string {
	const have = new Set(untrackedText.split("\0").filter((path) => path.length > 0));
	const add = extras.filter((path) => !have.has(path));
	if (add.length === 0) return untrackedText;
	const prefix =
		untrackedText.length === 0 || untrackedText.endsWith("\0")
			? untrackedText
			: `${untrackedText}\0`;
	return `${prefix}${add.join("\0")}\0`;
}

/**
 * An extra file that was already in the baseline is not a session addition.
 * Content that has changed since then is a modification; a file that is gone
 * is a deletion.
 */
async function withoutBaselineExtras(
	dir: string,
	entries: GitEntry[],
	side: Map<string, string>,
): Promise<GitEntry[]> {
	if (side.size === 0) return entries;
	const kept: GitEntry[] = [];
	const seen = new Set<string>();
	for (const entry of entries) {
		seen.add(entry.path);
		const recorded = side.get(entry.path);
		if (entry.y !== "?" || recorded === undefined) {
			kept.push(entry);
			continue;
		}
		const now = await hashWorktree(dir, entry.path);
		if (now === recorded) continue;
		kept.push({ ...entry, y: now === null ? "D" : "M" });
	}
	for (const [path, recorded] of side) {
		if (seen.has(path)) continue;
		const now = await hashWorktree(dir, path);
		if (now === recorded) continue;
		kept.push({
			path,
			x: ".",
			y: now === null ? "D" : "M",
			unmerged: false,
		});
	}
	return kept;
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
	// `--no-ext-diff` does not disable content filters.
	const config = await contentFilterOverrides(dir);
	if (!config) throw new AgentFailure("GIT_FAILED", "baseline status failed");
	const diff = await runGit(
		["diff", "-z", "--no-ext-diff", "--name-status", "--find-renames", objectId],
		dir,
		32 * 1024 * 1024,
		GIT_TIMEOUT_MS,
		{ config },
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
	const extras = await extraBaselinePaths(dir);
	const untrackedText = mergeExtraPaths(
		dropSkipped(untracked.stdout.toString()),
		extras,
	);
	const side = await untrackedSide(dir, objectId);
	const all = await withoutBaselineExtras(
		dir,
		baselineEntries(diff.stdout.toString(), untrackedText),
		side,
	);
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
	const config = await contentFilterOverrides(dir);
	if (!config) throw new AgentFailure("GIT_FAILED", "baseline status failed");
	const result = await runGit(
		["diff", "-z", "--no-ext-diff", "--name-status", "--find-renames", objectId],
		dir,
		32 * 1024 * 1024,
		GIT_TIMEOUT_MS,
		{ config },
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
	const treeKind = kind.ok ? kind.stdout.toString().trim() : "";
	if (treeKind && treeKind !== "blob") {
		throw new AgentFailure("PATH_INVALID", "not a file");
	}
	// Untracked content from before the session lives on the parentless
	// second parent, the same place baseline status reads (SPEC.md §12.7).
	let before = MISSING;
	if (treeKind === "blob") {
		before = await showFromRev(dir, objectId, beforePath, options);
	} else if ((await untrackedSide(dir, objectId)).has(beforePath)) {
		before = await showFromRev(dir, `${objectId}^2`, beforePath, options);
	}
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
