import { stat } from "node:fs/promises";
import { errorMessage } from "@portikus/observability";
import type { IncusClient } from "./incus.js";

/** The shared coding-agent tools on the platform VM (SPEC.md section 10). */
export const CODING_AGENTS_HOST_BIN = "/var/lib/portikus/coding-agents/bin";

/** Where the shared tools appear inside every workspace. */
const CODING_AGENTS_WORKSPACE_BIN = "/opt/portikus/coding-agents/bin";

/** /usr/local/bin is ahead of /usr/bin on the PATH, so these win over an image's own copies. */
const CODING_AGENT_LINKS = ["claude", "codex"].map((tool) => ({
	path: `/usr/local/bin/${tool}`,
	target: `${CODING_AGENTS_WORKSPACE_BIN}/${tool}`,
}));

type FilesClient = Pick<IncusClient, "pushFile" | "replaceFile">;

/**
 * Point the workspace's claude and codex at the shared tools, so a workspace
 * on an older image moves to them at its next start. Does nothing when the
 * host has no shared folder. Everything goes through the Incus files API, so
 * a link a student put on /usr/local/bin resolves inside the container,
 * never on the host. A file, link or empty folder at a link path is
 * replaced; a non-empty folder is refused. Each link is tried on its own and
 * the failures are thrown together afterwards.
 */
export async function writeCodingAgentLinks(
	client: FilesClient,
	name: string,
	hostBinDir: string,
	signal?: AbortSignal,
): Promise<boolean> {
	try {
		if (!(await stat(hostBinDir)).isDirectory()) return false;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw err;
	}
	// Incus answers success whatever already sits at the folder path.
	await client.pushFile(
		name,
		"/usr/local/bin",
		"",
		{ uid: 0, gid: 0, mode: "0755", type: "directory" },
		signal,
	);
	const failures: string[] = [];
	for (const { path, target } of CODING_AGENT_LINKS) {
		try {
			await client.replaceFile(
				name,
				path,
				target,
				{ uid: 0, gid: 0, mode: "0777", type: "symlink" },
				signal,
			);
		} catch (err) {
			failures.push(`${path}: ${errorMessage(err)}`);
		}
	}
	if (failures.length > 0) throw new Error(failures.join("; "));
	return true;
}
