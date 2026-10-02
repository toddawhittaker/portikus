import { existsSync, readFileSync } from "node:fs";
import { type LtiPlatform, loadPlatformsFile } from "@portikus/auth";
import type { ApiConfig } from "@portikus/config";

/** What the API loaded at start for LTI. */
export interface LtiDeps {
	platforms: LtiPlatform[];
	/** The tool's private key in PEM; only its public half is ever served. */
	toolKeyPem: string | null;
}

/**
 * Load the platforms file at start. Ansible always sets the variables, so a
 * missing file means LTI is off; a file that is there but wrong throws
 * PlatformsFileError and stops the start.
 */
export async function loadLtiDeps(
	config: Pick<ApiConfig, "LTI_PLATFORMS_FILE" | "LTI_TOOL_KEY_FILE">,
): Promise<LtiDeps | undefined> {
	const file = config.LTI_PLATFORMS_FILE;
	if (!file || !existsSync(file)) return undefined;
	const keyFile = config.LTI_TOOL_KEY_FILE;
	return {
		platforms: await loadPlatformsFile(file),
		toolKeyPem: keyFile && existsSync(keyFile) ? readFileSync(keyFile, "utf8") : null,
	};
}
