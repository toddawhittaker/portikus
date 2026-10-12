// The session baseline: a dangling stash commit recorded at terminal start, and status and diffs against it (SPEC.md §12.7, ADR 0019).
import type { Dirent } from "node:fs";
import { lstat, mkdtemp, readdir, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	GIT_TIMEOUT_MS,
	type GitDiff,
	type GitEntry,
	type GitStatus,
	MAX_GIT_ENTRIES,
} from "@portikus/contracts";
import { finishDiff, MISSING, readWorkingTree } from "./diff-side.js";
import { AgentFailure } from "./errors.js";
import {
	diffablePath,
	emptyStatus,
	type GitDebugLog,
	isRepoRoot,
	OBJECT_ID,
	type PathState,
	projectDir,
	showFromRev,
} from "./git.js";
import { runGit } from "./git-runner.js";

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

/** Write one extra file or symlink as a blob; null when it cannot be read. */
async function hashExtraFile(
	dir: string,
	path: string,
): Promise<{ path: string; oid: string; mode: string } | null> {
	const full = join(dir, path);
	const info = await lstat(full).catch(() => null);
	if (!info) return null;
	let oid = "";
	let mode = "";
	if (info.isSymbolicLink()) {
		// The blob is the link text. Hashing the path would follow it.
		const target = await readlink(full).catch(() => null);
		if (target === null) return null;
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
		return null;
	}
	return OBJECT_ID.test(oid) ? { path, oid, mode } : null;
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
			const blob = await hashExtraFile(dir, path);
			if (blob) blobs.push(blob);
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
	const { dir, repo, target } = await diffablePath(homeDir, slug, relPath);
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
