/**
 * Seed the coding agents' global instruction files in the student's home
 * (SPEC.md §4.4, §10). The image ships a template; each home gets its own
 * copy once and keeps it, so a student's or agent's edits survive rebuilds.
 */
import { constants } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Where the workspace image puts the template. */
export const AGENT_INSTRUCTIONS_TEMPLATE = "/usr/share/portikus/AGENTS.md";

/** Codex's global instructions file, relative to the home folder. */
export const CODEX_INSTRUCTIONS = ".codex/AGENTS.md";

/** Claude Code's user memory file, relative to the home folder. */
export const CLAUDE_INSTRUCTIONS = ".claude/CLAUDE.md";

/** Claude Code reads the Codex file through an import, so both share one text. */
export const CLAUDE_IMPORT_LINE = "@~/.codex/AGENTS.md\n";

/**
 * Create each file only when nothing is at its path. Returns the files it
 * created. An old image without the template gets neither file.
 */
export async function seedAgentInstructions(
	homeDir: string,
	templatePath: string = AGENT_INSTRUCTIONS_TEMPLATE,
): Promise<string[]> {
	const created: string[] = [];
	const codex = join(homeDir, CODEX_INSTRUCTIONS);
	const claude = join(homeDir, CLAUDE_INSTRUCTIONS);

	// Both folders hold sign-in tokens, so a new one is private.
	await mkdir(join(homeDir, ".codex"), { recursive: true, mode: 0o700 });
	try {
		// COPYFILE_EXCL refuses any existing path, a symbolic link included.
		await copyFile(templatePath, codex, constants.COPYFILE_EXCL);
		created.push(CODEX_INSTRUCTIONS);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return created;
		if (code !== "EEXIST") throw error;
	}

	await mkdir(join(homeDir, ".claude"), { recursive: true, mode: 0o700 });
	try {
		await writeFile(claude, CLAUDE_IMPORT_LINE, { flag: "wx", mode: 0o644 });
		created.push(CLAUDE_INSTRUCTIONS);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	return created;
}
