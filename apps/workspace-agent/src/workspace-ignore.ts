/**
 * Which project paths a recovery point leaves out (SPEC.md §15.5, ADR 0020).
 *
 * The SPEC 15.5 defaults come first and `.workspaceignore` adds to them in
 * `.gitignore` syntax, so `!dist/` there brings `dist/` back.
 */
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_RECOVERY_EXCLUDES, WORKSPACEIGNORE_FILE } from "@portikus/contracts";
import ignore from "ignore";

/** A larger `.workspaceignore` is not read; the defaults still apply. */
export const WORKSPACEIGNORE_LIMIT = 64 * 1024;

export interface RecoveryMatcher {
	/** True when a project-relative path is left out. Directories end in `/`. */
	excludes(relativePath: string): boolean;
}

/** Build the matcher from the defaults plus the given `.workspaceignore` text. */
export function recoveryMatcher(workspaceIgnore: string): RecoveryMatcher {
	const rules = ignore()
		.add([...DEFAULT_RECOVERY_EXCLUDES])
		.add(workspaceIgnore);
	return { excludes: (relativePath) => rules.ignores(relativePath) };
}

/**
 * Read the project's `.workspaceignore`. A symlink or anything but a small
 * regular file is not read, so the file cannot point the agent elsewhere.
 */
export async function loadRecoveryMatcher(
	projectPath: string,
): Promise<RecoveryMatcher> {
	const path = join(projectPath, WORKSPACEIGNORE_FILE);
	let text = "";
	try {
		// O_NOFOLLOW refuses a symlink at open time, and O_NONBLOCK keeps a
		// FIFO planted under this name from hanging the open.
		const handle = await open(
			path,
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
		try {
			const info = await handle.stat();
			if (info.isFile() && info.size <= WORKSPACEIGNORE_LIMIT) {
				text = await handle.readFile("utf8");
			}
		} finally {
			await handle.close();
		}
	} catch {
		// No file, or a link: the defaults alone.
	}
	return recoveryMatcher(text);
}
