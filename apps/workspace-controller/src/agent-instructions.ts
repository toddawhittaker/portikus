import { readFile } from "node:fs/promises";
import type { IncusClient } from "./incus.js";
import { IncusError } from "./incus.js";

/**
 * The coding agents' platform instructions (SPEC.md §3). One
 * template ships in the Portikus package, next to the workspace agent, so a
 * change reaches every workspace at its next start without a new image.
 */
export const AGENT_INSTRUCTIONS_HOST_PATH =
	"/usr/lib/portikus/workspace-agent/agent-instructions.md";

/** Claude Code's system-wide memory file, read in every session. */
export const CLAUDE_SYSTEM_PATH = "/etc/claude-code/CLAUDE.md";

/** Codex's system config layer; a pilot test showed it applies developer_instructions. */
export const CODEX_SYSTEM_PATH = "/etc/codex/config.toml";

/** The line the image already ships in the Codex system config. */
const CODEX_UPDATE_LINE = "check_for_update_on_startup = false";

/** The Codex system config holding the template. A JSON string is a valid TOML basic string. */
export function codexSystemConfig(template: string): string {
	return (
		"# Written by Portikus at every workspace start; edits do not last.\n" +
		`${CODEX_UPDATE_LINE}\n` +
		`developer_instructions = ${JSON.stringify(template)}\n`
	);
}

type FilesClient = Pick<IncusClient, "pushFile" | "deleteFile">;

const ROOT_DIR = { uid: 0, gid: 0, mode: "0755", type: "directory" } as const;
const ROOT_FILE = { uid: 0, gid: 0, mode: "0644" } as const;

/**
 * Put `body` at `path` without ever reading or opening what is there: a
 * student who is root can leave a named pipe, and opening one blocks.
 * Deleting first replaces a pipe, link or file alike; anything that cannot
 * be deleted, such as a non-empty directory, is refused.
 */
export async function replaceFile(
	client: FilesClient,
	name: string,
	path: string,
	body: string,
	signal?: AbortSignal,
): Promise<void> {
	try {
		await client.deleteFile(name, path, signal);
	} catch (err) {
		if (!(err instanceof IncusError && err.code === "NOT_FOUND")) {
			throw new Error(`${path} cannot be replaced: ${(err as Error).message}`);
		}
	}
	await client.pushFile(name, path, body, ROOT_FILE, signal);
}

/**
 * Write both system files from the template, undoing any edit or deletion.
 * Does nothing when the host has no template. Each file is tried on its own,
 * so one that cannot be written does not skip the other; the failures are
 * thrown together afterwards.
 */
export async function writeAgentInstructions(
	client: FilesClient,
	name: string,
	templatePath: string,
	signal?: AbortSignal,
): Promise<boolean> {
	let template: string;
	try {
		template = await readFile(templatePath, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw err;
	}
	const files: [dir: string, path: string, body: string][] = [
		["/etc/claude-code", CLAUDE_SYSTEM_PATH, template],
		["/etc/codex", CODEX_SYSTEM_PATH, codexSystemConfig(template)],
	];
	const failures: string[] = [];
	for (const [dir, path, body] of files) {
		try {
			// Incus answers success whatever already sits at the folder path;
			// a non-folder there makes the file push below fail instead.
			await client.pushFile(name, dir, "", ROOT_DIR, signal);
			await replaceFile(client, name, path, body, signal);
		} catch (err) {
			failures.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	if (failures.length > 0) throw new Error(failures.join("; "));
	return true;
}
