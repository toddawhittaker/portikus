import { access, readFile } from "node:fs/promises";
import {
	HUB_MIRROR_URL,
	REGISTRY_GATEWAY_ADDR,
	type WorkspaceDockerConfig,
} from "@portikus/contracts";
import type { Logger } from "@portikus/observability";
import { replaceFile } from "./agent-instructions.js";
import { type IncusClient, IncusError } from "./incus.js";

/**
 * What the controller writes into a workspace's Docker setup before it
 * starts (issue #840, ruling 9): the Hub cache as a registry mirror, and
 * while the ghcr.io cache is on, a hosts entry and the CA Docker trusts for
 * it. Everything goes through the Incus files API, which resolves paths
 * inside the container, never on the host.
 *
 * The controller owns daemon.json and /etc/hosts whole and never reads
 * them: a student who is root could leave a named pipe there, and reading
 * one blocks (see replaceFile).
 */

export const DAEMON_JSON_PATH = "/etc/docker/daemon.json";
export const GHCR_CERT_DIR = "/etc/docker/certs.d/ghcr.io";
export const GHCR_CERT_PATH = `${GHCR_CERT_DIR}/ca.crt`;
export const HOSTS_PATH = "/etc/hosts";
/** The CA the root cache helper made; public, readable by the controller. */
export const GHCR_CA_HOST_PATH = "/etc/portikus/registry/ghcr-ca.crt";
/** Setup writes this when the pull cache does not fit on disk (SPEC.md 16.6). */
export const CACHE_OFF_HOST_PATH = "/etc/portikus/registry/cache-off";
/** Marks the one hosts line the controller owns. */
export const GHCR_HOSTS_MARKER = "# portikus-ghcr-cache";

/**
 * The image's daemon.json (the overlay2 pin with the containerd snapshotter
 * off, SPEC.md 16.2) plus our mirror when it is on.
 */
export function daemonJson(hubMirror: boolean): string {
	const config: Record<string, unknown> = {
		"storage-driver": "overlay2",
		features: { "containerd-snapshotter": false },
	};
	if (hubMirror) config["registry-mirrors"] = [HUB_MIRROR_URL];
	return `${JSON.stringify(config, null, 2)}\n`;
}

/**
 * The whole /etc/hosts: Debian's defaults, the instance's name as the
 * image's template writes it, and our ghcr.io line when `ghcr` is on.
 */
export function workspaceHosts(name: string, ghcr: boolean): string {
	const lines = [
		"127.0.0.1 localhost",
		`127.0.1.1 ${name}`,
		"::1 localhost ip6-localhost ip6-loopback",
		"ff02::1 ip6-allnodes",
		"ff02::2 ip6-allrouters",
	];
	if (ghcr) lines.push(`${REGISTRY_GATEWAY_ADDR} ghcr.io ${GHCR_HOSTS_MARKER}`);
	return `${lines.join("\n")}\n`;
}

type FilesClient = Pick<IncusClient, "pushFile" | "deleteFile">;

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

const ROOT_DIR = { uid: 0, gid: 0, mode: "0755", type: "directory" } as const;

/** Write the Docker config into a workspace, normally while it is stopped. */
export async function writeDockerConfig(
	client: FilesClient,
	name: string,
	config: WorkspaceDockerConfig,
	opts: { caPath: string; cacheOffPath?: string; log: Logger },
	signal?: AbortSignal,
): Promise<boolean> {
	// With the cache off nothing listens, so neither mirror nor ghcr.io entry may point at it.
	if (await exists(opts.cacheOffPath ?? CACHE_OFF_HOST_PATH)) {
		config = { ...config, hubMirror: false, ghcr: false };
	}
	// Creates the folder or keeps an existing one; fails on anything else there.
	await client.pushFile(name, "/etc/docker", "", ROOT_DIR, signal);
	await replaceFile(
		client,
		name,
		DAEMON_JSON_PATH,
		daemonJson(config.hubMirror),
		signal,
	);

	let ca: string | null = null;
	if (config.ghcr) {
		try {
			ca = await readFile(opts.caPath, "utf8");
		} catch (err) {
			opts.log.warn(
				{ instance: name, err: err instanceof Error ? err.message : String(err) },
				"the ghcr.io cache's CA cannot be read; leaving ghcr.io uncached",
			);
		}
	}
	const ghcr = ca !== null;

	if (ca !== null) {
		for (const d of ["/etc/docker/certs.d", GHCR_CERT_DIR]) {
			await client.pushFile(name, d, "", ROOT_DIR, signal);
		}
		await replaceFile(client, name, GHCR_CERT_PATH, ca, signal);
	} else {
		try {
			await client.deleteFile(name, GHCR_CERT_PATH, signal);
		} catch (err) {
			if (!(err instanceof IncusError && err.code === "NOT_FOUND")) throw err;
		}
	}

	await writeGhcrHosts(client, name, ghcr, signal);
	return ghcr;
}

/**
 * Write a workspace's /etc/hosts with or without our ghcr.io line. Also run
 * after a start: the image's create/copy template rewrites /etc/hosts at the
 * first start after a create or copy, dropping a line written beforehand.
 */
export async function writeGhcrHosts(
	client: FilesClient,
	name: string,
	ghcr: boolean,
	signal?: AbortSignal,
): Promise<void> {
	await replaceFile(client, name, HOSTS_PATH, workspaceHosts(name, ghcr), signal);
}
