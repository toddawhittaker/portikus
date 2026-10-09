/**
 * One file of a recovery point against its working copy (SPEC.md §15.8,
 * §12.6). Only the one member is read, to stdout, so nothing is written to
 * disk and no other member's name matters. File names never reach a log
 * line (ADR 0012).
 */
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import {
	type GitDiff,
	MAX_DIFF_SIDE_BYTES,
	ProjectPath,
	RECOVERY_DIFF_TIMEOUT_MS,
} from "@portikus/contracts";
import { AgentFailure } from "./errors.js";
import { resolveInProject } from "./files.js";
import {
	assertId,
	pointDirectory,
	type RecoveryPaths,
	readArchive,
	safeMemberName,
} from "./recovery.js";

const SNIFF_BYTES = 8 * 1024;

interface Side {
	content: Buffer | null;
	tooLarge: boolean;
}

const MISSING: Side = { content: null, tooLarge: false };

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
	return finish(before, after);
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
	const info = await lstat(target.path).catch(() => null);
	if (info === null) return MISSING;
	if (!info.isFile()) throw new AgentFailure("PATH_INVALID", "not a file");
	if (info.size > MAX_DIFF_SIDE_BYTES) return { content: null, tooLarge: true };
	const handle = await open(target.path, "r");
	try {
		return { content: await handle.readFile(), tooLarge: false };
	} finally {
		await handle.close();
	}
}

function isBinary(side: Side): boolean {
	return side.content?.subarray(0, SNIFF_BYTES).includes(0) ?? false;
}

function finish(before: Side, after: Side): GitDiff {
	const tooLarge = before.tooLarge || after.tooLarge;
	const binary = !tooLarge && (isBinary(before) || isBinary(after));
	let status: GitDiff["status"] = "M";
	if (before.content === null && !before.tooLarge) status = "A";
	else if (after.content === null && !after.tooLarge) status = "D";
	const hide = tooLarge || binary;
	return {
		status,
		before: hide || before.content === null ? null : before.content.toString("utf8"),
		after: hide || after.content === null ? null : after.content.toString("utf8"),
		binary,
		tooLarge,
	};
}
