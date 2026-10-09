/**
 * One side of a file diff and how a pair of sides becomes a `GitDiff`
 * (SPEC.md §12.6). Shared by the HEAD, Git-ref and recovery-point diffs.
 */
import { open, stat } from "node:fs/promises";
import { type GitDiff, MAX_DIFF_SIDE_BYTES } from "@portikus/contracts";

const SNIFF_BYTES = 8 * 1024;

export interface Side {
	content: Buffer | null;
	tooLarge: boolean;
}

export const MISSING: Side = { content: null, tooLarge: false };

/** Read the working-tree side, capped at `MAX_DIFF_SIDE_BYTES`. */
export async function readWorkingTree(path: string): Promise<Side> {
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

export function finishDiff(
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
