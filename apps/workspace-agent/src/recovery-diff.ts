/**
 * One file of a recovery point against its working copy (SPEC.md §15.8,
 * §12.6). Only the one member is read, to stdout, so nothing is written to
 * disk and no other member's name matters. File names never reach a log
 * line (ADR 0012).
 */
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import {
	type GitDiff,
	MAX_DIFF_SIDE_BYTES,
	ProjectPath,
	RECOVERY_DIFF_TIMEOUT_MS,
} from "@portikus/contracts";
import { finishDiff, MISSING, readWorkingTree, type Side } from "./diff-side.js";
import { AgentFailure } from "./errors.js";
import { resolveInProject } from "./files.js";
import {
	assertId,
	pointDirectory,
	type RecoveryPaths,
	readArchive,
	safeMemberName,
} from "./recovery.js";

export interface RecoveryDiffInput {
	slug: string;
	projectId: string;
	pointId: string;
	path: string;
	sha256: string;
	timeoutMs?: number;
}

/**
 * The point's version of `path` as `before`, the working copy as `after`.
 * The archive must hash to `sha256` before any of its bytes are returned.
 */
export async function recoveryPointDiff(
	paths: RecoveryPaths,
	input: RecoveryDiffInput,
): Promise<GitDiff> {
	assertId(input.projectId);
	assertId(input.pointId);
	if (!ProjectPath.safeParse(input.path).success || !safeMemberName(input.path)) {
		throw new AgentFailure("PATH_INVALID", "invalid path");
	}
	const after = await readWorkingCopy(paths.homeDir, input.slug, input.path);

	const dir = await pointDirectory(paths.recoveryRoot, input.projectId, false);
	const read = await readArchive(
		join(dir, `${input.pointId}.tar.zst`),
		[
			"--extract",
			"--to-stdout",
			// The name is matched literally, and a directory is not expanded
			// into every file under it.
			"--no-wildcards",
			"--no-recursion",
			"--",
			input.path,
		],
		{
			maxStdoutBytes: MAX_DIFF_SIDE_BYTES + 1,
			timeoutMs: input.timeoutMs ?? RECOVERY_DIFF_TIMEOUT_MS,
		},
	);
	if (read.sha256 !== input.sha256) {
		throw new AgentFailure(
			"RECOVERY_POINT_INVALID",
			"the recovery point does not match its record",
		);
	}
	let before: Side;
	if (read.missingMember) before = MISSING;
	else if (read.overflow || read.stdout.length > MAX_DIFF_SIDE_BYTES)
		before = { content: null, tooLarge: true };
	else before = { content: read.stdout, tooLarge: false };

	if (
		before.content === null &&
		!before.tooLarge &&
		after.content === null &&
		!after.tooLarge
	) {
		throw new AgentFailure(
			"FILE_NOT_FOUND",
			"no such file in the point or the project",
		);
	}
	return finishDiff(before, after, false, undefined);
}

/** The working copy, capped; absent when it or its folder is gone. */
async function readWorkingCopy(
	homeDir: string,
	slug: string,
	relPath: string,
): Promise<Side> {
	let target: { path: string; exists: boolean };
	try {
		target = await resolveInProject(homeDir, slug, relPath, { mustExist: false });
	} catch (error) {
		if (error instanceof AgentFailure && error.code === "FILE_NOT_FOUND")
			return MISSING;
		throw error;
	}
	// lstat, so a symlink at the leaf is refused rather than followed.
	const info = await lstat(target.path).catch(() => null);
	if (info === null) return MISSING;
	if (!info.isFile()) throw new AgentFailure("PATH_INVALID", "not a file");
	return readWorkingTree(target.path);
}
