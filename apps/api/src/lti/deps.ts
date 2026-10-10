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
 * Load the platforms files at start. Ansible always sets the variables, and
 * LTI is off only when neither the operator's file nor the page's names a
 * platform. An operator file that is there but wrong throws
 * PlatformsFileError and stops the start.
 *
 * The platforms an administrator registered on the page are added after the
 * operator's (ADR 0059). That file is skipped, with `onSkipped` told why,
 * when it is wrong, and an entry that repeats an operator platform's name
 * or issuer and client ID is dropped: the operator's file wins.
 */
export async function loadLtiDeps(
	config: Pick<ApiConfig, "LTI_PLATFORMS_FILE" | "LTI_TOOL_KEY_FILE"> &
		Partial<Pick<ApiConfig, "LTI_ADMIN_PLATFORMS_FILE">>,
	onSkipped: (message: string) => void = () => {},
): Promise<LtiDeps | undefined> {
	const file = config.LTI_PLATFORMS_FILE;
	if (!file) return undefined;
	const keyFile = config.LTI_TOOL_KEY_FILE;
	const operator = existsSync(file) ? await loadPlatformsFile(file) : [];
	const added = await loadPagePlatforms(config.LTI_ADMIN_PLATFORMS_FILE, onSkipped);
	const taken = (p: LtiPlatform) =>
		operator.some(
			(o) => o.name === p.name || (o.issuer === p.issuer && o.clientId === p.clientId),
		);
	const platforms = [...operator, ...added.filter((p) => !taken(p))];
	if (platforms.length === 0) return undefined;
	return {
		platforms,
		toolKeyPem: keyFile && existsSync(keyFile) ? readFileSync(keyFile, "utf8") : null,
	};
}

/** The page-registered platforms, or none when the file is absent or wrong. */
export async function loadPagePlatforms(
	file: string | undefined,
	onSkipped: (message: string) => void,
): Promise<LtiPlatform[]> {
	if (!file || !existsSync(file)) return [];
	try {
		const platforms = await loadPlatformsFile(file);
		// The job refuses mocks; a hand-edited file must not enable one either.
		return platforms.filter((p) => !p.mock);
	} catch (error) {
		onSkipped(
			error instanceof Error ? error.message : "the page platforms file is wrong",
		);
		return [];
	}
}
