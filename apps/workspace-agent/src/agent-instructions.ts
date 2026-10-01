/**
 * Give the coding agents' home instruction files back to the student
 * (SPEC.md §3, issue #933). The platform's guidance now lives in system
 * files the workspace controller writes at every start, so the copies an
 * older agent put in the home folder are taken out again, and nothing a
 * student wrote is touched.
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import { join } from "node:path";

/** Codex's global instructions file, relative to the home folder. */
export const CODEX_INSTRUCTIONS = ".codex/AGENTS.md";

/** Claude Code's user memory file, relative to the home folder. */
export const CLAUDE_INSTRUCTIONS = ".claude/CLAUDE.md";

/** The one line an older agent wrote into the Claude file. */
export const CLAUDE_IMPORT_LINE = "@~/.codex/AGENTS.md";

/**
 * SHA-256 of every template an older image shipped and an older agent
 * copied to ~/.codex/AGENTS.md. Only an unchanged copy is removed.
 */
export const PAST_TEMPLATE_HASHES: readonly string[] = [
	"68e96566d0fd28c6161f9839c4e55d99b3cf208eeba6fa1e03374d0b22475bcb",
	"d1a0de6225863daf3555d18c40511eeb926fce732d61523d47849cbc9e1349bf",
];

/** Read a regular file without following a symbolic link; null if absent or not plain. */
async function readPlainFile(path: string): Promise<string | null> {
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ELOOP") return null;
		throw error;
	}
	try {
		if (!(await handle.stat()).isFile()) return null;
		return await handle.readFile("utf8");
	} finally {
		await handle.close();
	}
}

/** Unlink only if the path is still a regular file, never a link. */
async function unlinkPlainFile(path: string): Promise<void> {
	if ((await lstat(path)).isFile()) await unlink(path);
}

/**
 * Remove the platform's own leftovers from the home folder. Returns the
 * files it changed. Symbolic links are never followed or replaced.
 */
export async function returnHomeInstructions(
	homeDir: string,
	pastHashes: readonly string[] = PAST_TEMPLATE_HASHES,
): Promise<string[]> {
	const changed: string[] = [];

	const codex = join(homeDir, CODEX_INSTRUCTIONS);
	const codexText = await readPlainFile(codex);
	if (codexText !== null) {
		const hash = createHash("sha256").update(codexText).digest("hex");
		if (pastHashes.includes(hash)) {
			await unlinkPlainFile(codex);
			changed.push(CODEX_INSTRUCTIONS);
		}
	}

	// The import line stays while a student's Codex file does, so Claude Code keeps reading it.
	const codexGone = await lstat(codex).then(
		() => false,
		(error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return true;
			throw error;
		},
	);

	const claude = join(homeDir, CLAUDE_INSTRUCTIONS);
	const claudeText = codexGone ? await readPlainFile(claude) : null;
	if (claudeText !== null) {
		const lines = claudeText.split("\n");
		const kept = lines.filter((line) => line !== CLAUDE_IMPORT_LINE);
		if (kept.length !== lines.length) {
			const rest = kept.join("\n");
			if (rest.trim() === "") {
				await unlinkPlainFile(claude);
			} else {
				// O_NOFOLLOW: the file was swapped for a link since the read.
				const handle = await open(
					claude,
					constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW,
				);
				try {
					await handle.writeFile(rest);
				} finally {
					await handle.close();
				}
			}
			changed.push(CLAUDE_INSTRUCTIONS);
		}
	}
	return changed;
}
