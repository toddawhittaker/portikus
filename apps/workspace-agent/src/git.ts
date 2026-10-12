import { lstat } from "node:fs/promises";
import { join } from "node:path";
import {
	type GitDiff,
	type GitEntry,
	type GitStatus,
	MAX_DIFF_SIDE_BYTES,
	MAX_GIT_ENTRIES,
} from "@portikus/contracts";
import { finishDiff, MISSING, readWorkingTree, type Side } from "./diff-side.js";
import { AgentFailure } from "./errors.js";
import { resolveInProject } from "./files.js";
import { runGit } from "./git-runner.js";

/** Somewhere to put git stderr that is not the response body (STACK.md §15). */
export interface GitDebugLog {
	debug: (details: object, message: string) => void;
}

export function emptyStatus(): GitStatus {
	return {
		repo: false,
		branch: null,
		detached: false,
		oid: null,
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
			readBranchHeader(status, record);
			continue;
		}

		let item: string | GitEntry | null;
		if (kind === "!") {
			item = record.slice(2);
		} else {
			// A rename's original path is the next NUL-separated field.
			const origPath = kind === "2" ? (records[i + 1] ?? "") : undefined;
			if (kind === "2") i += 1;
			item = parseEntry(record, origPath);
			if (!item) continue;
			// Every `u` record is a conflict, including both-added (AA) and
			// both-deleted (DD) (SPEC.md §12.8).
			if (item.unmerged) status.conflicts += 1;
		}

		if (budget <= 0) {
			status.truncated = true;
			continue;
		}
		budget -= 1;
		if (typeof item === "string") status.ignored.push(item);
		else status.entries.push(item);
	}
	return status;
}

/** Apply one `# branch.*` header line to `status`. */
function readBranchHeader(status: GitStatus, record: string): void {
	const [, key, ...rest] = record.split(" ");
	const value = rest.join(" ");
	if (key === "branch.oid") {
		// "(initial)" means there is no commit yet.
		status.oid = OBJECT_ID.test(value) ? value : null;
	} else if (key === "branch.head") {
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
}

/** One changed, untracked, renamed or unmerged record; null for any other kind. */
function parseEntry(record: string, origPath: string | undefined): GitEntry | null {
	const kind = record[0];
	if (kind === "?") {
		return { path: record.slice(2), x: "?", y: "?", unmerged: false };
	}
	const fields = record.split(" ");
	if (kind === "1") {
		const xy = fields[1] ?? "..";
		return {
			path: fields.slice(8).join(" "),
			x: xy[0] ?? ".",
			y: xy[1] ?? ".",
			unmerged: false,
		};
	}
	if (kind === "2") {
		const xy = fields[1] ?? "..";
		const entry: GitEntry = {
			path: fields.slice(9).join(" "),
			x: xy[0] ?? ".",
			y: xy[1] ?? ".",
			unmerged: false,
		};
		if (origPath) entry.origPath = origPath;
		return entry;
	}
	if (kind === "u") {
		const xy = fields[1] ?? "UU";
		return {
			path: fields.slice(10).join(" "),
			x: xy[0] ?? "U",
			y: xy[1] ?? "U",
			unmerged: true,
		};
	}
	return null;
}

/** The project directory, or a failure if the project is missing. */
export async function projectDir(homeDir: string, slug: string): Promise<string> {
	const target = await resolveInProject(homeDir, slug, "", { mustExist: true });
	return target.path;
}

/**
 * True when `dir` is itself the top of a work tree. A project sitting inside
 * some other repository must not report that repository's status.
 */
export async function isRepoRoot(dir: string): Promise<boolean> {
	const result = await runGit(["rev-parse", "--show-toplevel"], dir, 64 * 1024);
	if (!result.ok) return false;
	const top = result.stdout.toString().trim();
	return top === dir;
}

/** Drop the trailing partial record of a truncated NUL-separated stream. */
export function completeRecords(text: string): string {
	const end = text.lastIndexOf("\0");
	return end === -1 ? "" : text.slice(0, end + 1);
}

/** True when the path inside `dir` is itself a symlink. */
export async function isLink(dir: string, relPath: string): Promise<boolean> {
	const info = await lstat(join(dir, relPath)).catch(() => null);
	return info?.isSymbolicLink() ?? false;
}

/**
 * The status without symlinks. Git never lists a path beneath a symlinked
 * directory, so only the last component needs checking (SPEC.md §5.2).
 */
export async function withoutLinks(dir: string, status: GitStatus): Promise<GitStatus> {
	const entries: GitEntry[] = [];
	for (const entry of status.entries) {
		if (!(await isLink(dir, entry.path))) entries.push(entry);
	}
	const ignored: string[] = [];
	for (const path of status.ignored) {
		if (!(await isLink(dir, path))) ignored.push(path);
	}
	return { ...status, entries, ignored };
}

/**
 * Read the repository status for one project (SPEC.md §12.1, §12.8). With
 * noLinks, symlinks are left out.
 */
export async function gitStatus(
	homeDir: string,
	slug: string,
	options: { hidden: boolean; noLinks?: boolean; log?: GitDebugLog },
): Promise<GitStatus> {
	const status = await readStatus(homeDir, slug, options);
	if (!options.noLinks || !status.repo) return status;
	return withoutLinks(await projectDir(homeDir, slug), status);
}

async function readStatus(
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

export interface PathState {
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
export async function pathState(dir: string, relPath: string): Promise<PathState> {
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
 * The project directory for a diff of `relPath`, and whether it is a
 * repository root. A directory is not a diffable file on either side: git
 * would show a tree listing as if it were the file's content. A missing path
 * is fine: the older side may still have it.
 */
export async function diffablePath(
	homeDir: string,
	slug: string,
	relPath: string,
	options: { noLinks?: boolean } = {},
): Promise<{ dir: string; repo: boolean; target: { path: string } }> {
	const dir = await projectDir(homeDir, slug);
	const target = await resolveInProject(homeDir, slug, relPath, {
		mustExist: false,
		noLinks: options.noLinks,
	});
	const info = await lstat(target.path).catch(() => null);
	if (info && !info.isFile()) {
		throw new AgentFailure("PATH_INVALID", "not a file");
	}
	return { dir, repo: await isRepoRoot(dir), target };
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
	options: { noLinks?: boolean; log?: GitDebugLog } = {},
): Promise<GitDiff> {
	const { dir, repo, target } = await diffablePath(homeDir, slug, relPath, {
		noLinks: options.noLinks,
	});
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

/** Read a blob out of an arbitrary object, with the same cap as HEAD. */
export async function showFromRev(
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
