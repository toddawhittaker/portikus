import { readFile } from "node:fs/promises";
import type { IncusClient } from "./incus.js";
import { IncusError } from "./incus.js";

/**
 * The coding agents' platform instructions (SPEC.md §3, issue #933). One
 * template ships in the Portikus package, next to the workspace agent, so a
 * change reaches every workspace at its next start without a new image.
 */
export const AGENT_INSTRUCTIONS_HOST_PATH =
	"/usr/lib/portikus/workspace-agent/agent-instructions.md";

/** Claude Code's system-wide memory file, read in every session. */
export const CLAUDE_SYSTEM_PATH = "/etc/claude-code/CLAUDE.md";

/** Codex's system config layer; a pilot test showed it applies developer_instructions. */
export const CODEX_SYSTEM_PATH = "/etc/codex/config.toml";

/** The line the image already ships in the Codex system config (issue #129). */
const CODEX_UPDATE_LINE = "check_for_update_on_startup = false";

/** The Codex system config holding the template. A JSON string is a valid TOML basic string. */
export function codexSystemConfig(template: string): string {
	return (
		"# Written by Portikus at every workspace start; edits do not last.\n" +
		`${CODEX_UPDATE_LINE}\n` +
		`developer_instructions = ${JSON.stringify(template)}\n`
	);
}

type FilesClient = Pick<IncusClient, "readFile" | "pushFile">;

const PROBE_MAX_BYTES = 64 * 1024;
const ROOT_DIR = { uid: 0, gid: 0, mode: "0755", type: "directory" } as const;
const ROOT_FILE = { uid: 0, gid: 0, mode: "0644" } as const;

/** The type at a path in the instance, or null when nothing is there. */
async function typeAt(
	client: FilesClient,
	name: string,
	path: string,
	signal?: AbortSignal,
): Promise<string | null> {
	try {
		const file = await client.readFile(name, path, PROBE_MAX_BYTES, signal);
		// A link's content is its target, far under 64 KiB, so an oversized read is no link.
		return file.tooLarge ? "file" : file.type;
	} catch (err) {
		if (err instanceof IncusError && err.code === "NOT_FOUND") return null;
		throw err;
	}
}

/**
 * Write both system files from the template, undoing any edit or deletion.
 * Does nothing when the host has no template. Refuses a path that is a
 * symbolic link: the link is not the file meant here.
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
	for (const [dir, path, body] of files) {
		const dirType = await typeAt(client, name, dir, signal);
		if (dirType === null) {
			await client.pushFile(name, dir, "", ROOT_DIR, signal);
		} else if (dirType !== "directory") {
			throw new Error(`${dir} is not a directory`);
		}
		const fileType = await typeAt(client, name, path, signal);
		if (fileType !== null && fileType !== "file") {
			throw new Error(`${path} is not a regular file`);
		}
		await client.pushFile(name, path, body, ROOT_FILE, signal);
	}
	return true;
}
