import { existsSync, readFileSync } from "node:fs";
import { type LtiPlatform, loadPlatformsFile } from "@portikus/auth";
import type { ApiConfig } from "@portikus/config";

/** What the API loaded at start for LTI. */
export interface LtiDeps {
	platforms: LtiPlatform[];
	/** The tool's private key in PEM; only its public half is ever served. */
	toolKeyPem: string | null;
}

type PlatformKey = Pick<LtiPlatform, "name" | "issuer" | "clientId" | "keysetUrl">;

/** True when `others` already has this platform's name, or its issuer and client ID. */
export function repeatsPlatform(
	p: PlatformKey,
	others: readonly PlatformKey[],
): boolean {
	return others.some(
		(o) => o.name === p.name || (o.issuer === p.issuer && o.clientId === p.clientId),
	);
}

/**
 * True when `others` registers this issuer with another key set. Accounts are
 * keyed by issuer and subject, so a second key set for one issuer could sign
 * launches as that issuer's existing users (SPEC.md section 24).
 */
export function keysetConflict(
	p: PlatformKey,
	others: readonly PlatformKey[],
): boolean {
	return others.some((o) => o.issuer === p.issuer && o.keysetUrl !== p.keysetUrl);
}

/**
 * Load the platforms at start: the operator's file, then the platforms an
 * administrator registered on the page (ADR 0059). Either file may be
 * missing; LTI is off only when neither holds a platform. An operator file
 * that is there but wrong throws PlatformsFileError and stops the start.
 *
 * The page file is skipped, with `onSkipped` told why, when it is wrong. A
 * page entry that repeats an operator platform's name or issuer and client
 * ID is dropped: the operator's file wins. One that names a registered
 * issuer with another key set is dropped and reported.
 */
export async function loadLtiDeps(
	config: Pick<ApiConfig, "LTI_PLATFORMS_FILE" | "LTI_TOOL_KEY_FILE"> &
		Partial<Pick<ApiConfig, "LTI_ADMIN_PLATFORMS_FILE">>,
	onSkipped: (message: string) => void = () => {},
): Promise<LtiDeps | undefined> {
	const file = config.LTI_PLATFORMS_FILE;
	const operator = file && existsSync(file) ? await loadPlatformsFile(file) : [];
	const platforms = [...operator];
	for (const p of await loadPagePlatforms(config.LTI_ADMIN_PLATFORMS_FILE, onSkipped)) {
		if (repeatsPlatform(p, operator)) continue;
		if (keysetConflict(p, platforms)) {
			onSkipped(`${p.name}: its issuer is already registered with another key set URL`);
			continue;
		}
		platforms.push(p);
	}
	if (platforms.length === 0) return undefined;
	const keyFile = config.LTI_TOOL_KEY_FILE;
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
