import type { GitDiff, GitRef } from "@portikus/contracts";
import { finishDiff, MISSING, readWorkingTree } from "./diff-side.js";
import { AgentFailure } from "./errors.js";
import { diffablePath, type GitDebugLog, OBJECT_ID, showFromRev } from "./git.js";
import { runGit } from "./git-runner.js";

/**
 * The commit a student-typed ref names, as a full object id. The route has
 * validated the ref as a GitRef, and it is passed after `--end-of-options`,
 * so it can never be read as a flag; `^{commit}` refuses a tree, a blob, or
 * a range.
 */
async function resolveCommit(dir: string, ref: GitRef): Promise<string> {
	const result = await runGit(
		["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`],
		dir,
		256,
	);
	const oid = result.ok ? result.stdout.toString().trim() : "";
	if (!OBJECT_ID.test(oid)) {
		throw new AgentFailure("BAD_REQUEST", "That Git ref does not name a commit.");
	}
	return oid;
}

/**
 * One file's working copy against its version at a Git ref (SPEC.md §12.6).
 * Read-only: nothing here writes a ref, the index, or the work tree
 * (SPEC.md §12.5). Only the resolved object id reaches `git show`.
 */
export async function refDiff(
	homeDir: string,
	slug: string,
	relPath: string,
	ref: GitRef,
	options: { log?: GitDebugLog } = {},
): Promise<GitDiff> {
	const { dir, repo, target } = await diffablePath(homeDir, slug, relPath);
	if (!repo) {
		throw new AgentFailure("BAD_REQUEST", "This project is not a Git repository.");
	}
	const oid = await resolveCommit(dir, ref);
	const kind = await runGit(["cat-file", "-t", `${oid}:${relPath}`], dir, 64);
	// A killed check says nothing about the file; reading it as missing
	// would show the whole file as added.
	if (kind.timedOut || kind.exitCode === null) {
		throw new AgentFailure("GIT_FAILED", "git cat-file failed");
	}
	const objectKind = kind.ok ? kind.stdout.toString().trim() : "";
	if (objectKind && objectKind !== "blob") {
		throw new AgentFailure("PATH_INVALID", "not a file");
	}
	const before =
		objectKind === "blob" ? await showFromRev(dir, oid, relPath, options) : MISSING;
	const after = await readWorkingTree(target.path);
	return finishDiff(before, after, false, undefined);
}
