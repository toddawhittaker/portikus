import { readFile } from "node:fs/promises";
import { type LtiPlatform, loadPlatformsFile } from "@portikus/auth";
import type { AdminLtiPlatform, OperatorLtiPlatform } from "@portikus/contracts";
import { z } from "zod";
import { loadPagePlatforms } from "../lti/deps.js";

/**
 * Readers for the files the site pages show (ADR 0059): the page-owned
 * lists, which the root job writes, and the operator's, which Ansible
 * owns. A missing or wrong file reads as empty, never as an error: the
 * page still has to open so a save can repair it.
 */

const ProxyHostsFile = z.object({ version: z.literal(1), hosts: z.array(z.string()) });

/**
 * A host list file: the page-owned proxy-hosts.json, or the operator's
 * operator-proxy-hosts.json that the egress_proxy role writes in the same shape.
 */
export async function readProxyHostsFile(path: string): Promise<string[]> {
	try {
		return ProxyHostsFile.parse(JSON.parse(await readFile(path, "utf8"))).hosts;
	} catch {
		return [];
	}
}

/** The platforms the page registered, as the page edits them. */
export async function readPagePlatforms(path: string): Promise<AdminLtiPlatform[]> {
	const platforms = await loadPagePlatforms(path, () => {});
	return platforms.map((p) => ({
		name: p.name,
		issuer: p.issuer,
		clientId: p.clientId,
		authLoginUrl: p.authLoginUrl,
		keysetUrl: p.keysetUrl,
		...(p.authTokenUrl ? { authTokenUrl: p.authTokenUrl } : {}),
		deploymentIds: p.deploymentIds,
		mock: false as const,
	}));
}

/** The operator's platforms file; none when it is missing or wrong. */
export async function readOperatorPlatforms(
	path: string | undefined,
): Promise<OperatorLtiPlatform[]> {
	if (!path) return [];
	let platforms: LtiPlatform[];
	try {
		platforms = await loadPlatformsFile(path);
	} catch {
		return [];
	}
	return platforms;
}
