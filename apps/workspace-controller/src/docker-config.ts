import { readFile } from "node:fs/promises";
import {
	HUB_MIRROR_URL,
	REGISTRY_GATEWAY_ADDR,
	type WorkspaceDockerConfig,
} from "@portikus/contracts";
import type { Logger } from "@portikus/observability";
import { type IncusClient, IncusError } from "./incus.js";

/**
 * What the controller writes into a workspace's Docker setup before it
 * starts (issue #840, ruling 9): the Hub cache as a registry mirror, and
 * while the ghcr.io cache is on, a hosts entry and the CA Docker trusts for
 * it. Everything goes through the Incus files API, which resolves paths
 * inside the container, never on the host.
 */

export const DAEMON_JSON_PATH = "/etc/docker/daemon.json";
export const GHCR_CERT_DIR = "/etc/docker/certs.d/ghcr.io";
export const GHCR_CERT_PATH = `${GHCR_CERT_DIR}/ca.crt`;
export const HOSTS_PATH = "/etc/hosts";
/** The CA the root cache helper made; public, readable by the controller. */
export const GHCR_CA_HOST_PATH = "/etc/portikus/registry/ghcr-ca.crt";
/** Marks the one hosts line the controller owns. */
export const GHCR_HOSTS_MARKER = "# portikus-ghcr-cache";

/** The most the controller reads of daemon.json or /etc/hosts. */
const CONFIG_MAX_BYTES = 64 * 1024;

/**
 * The image's daemon.json with the storage pin kept (overlay2, containerd
 * snapshotter off) and our mirror added or removed. Other keys and other
 * mirrors are kept; unreadable JSON starts again from the pin.
 */
export function mergeDaemonJson(existing: string | null, hubMirror: boolean): string {
	let config: Record<string, unknown> = {};
	if (existing !== null) {
		try {
			const parsed: unknown = JSON.parse(existing);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				config = parsed as Record<string, unknown>;
			}
		} catch {
			// A broken file is replaced by the pinned one below.
		}
	}
	const features =
		config.features &&
		typeof config.features === "object" &&
		!Array.isArray(config.features)
			? (config.features as Record<string, unknown>)
			: {};
	const mirrors = Array.isArray(config["registry-mirrors"])
		? (config["registry-mirrors"] as unknown[]).filter((m) => m !== HUB_MIRROR_URL)
		: [];
	if (hubMirror) mirrors.unshift(HUB_MIRROR_URL);
	const merged: Record<string, unknown> = {
		...config,
		"storage-driver": "overlay2",
		features: { ...features, "containerd-snapshotter": false },
	};
	if (mirrors.length > 0) merged["registry-mirrors"] = mirrors;
	else delete merged["registry-mirrors"];
	return `${JSON.stringify(merged, null, 2)}\n`;
}

/** /etc/hosts with our ghcr.io line removed, and added again when `ghcr` is on. */
export function hostsWithGhcr(existing: string, ghcr: boolean): string {
	const lines = existing.split("\n").filter((l) => !l.endsWith(GHCR_HOSTS_MARKER));
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	if (ghcr) lines.push(`${REGISTRY_GATEWAY_ADDR} ghcr.io ${GHCR_HOSTS_MARKER}`);
	return `${lines.join("\n")}\n`;
}

type FilesClient = Pick<IncusClient, "readFile" | "pushFile" | "deleteFile">;

async function readText(
	client: FilesClient,
	name: string,
	path: string,
	signal?: AbortSignal,
): Promise<{ type: string; text: string } | null> {
	try {
		const file = await client.readFile(name, path, CONFIG_MAX_BYTES, signal);
		if (file.tooLarge) throw new Error(`${path} is over 64 KiB`);
		return { type: file.type, text: file.content.toString("utf8") };
	} catch (err) {
		if (err instanceof IncusError && err.code === "NOT_FOUND") return null;
		throw err;
	}
}

const ROOT_FILE = { uid: 0, gid: 0, mode: "0644" } as const;

/**
 * Write the Docker config into a workspace, normally while it is stopped.
 * Refuses to write through a symbolic link at /etc/docker, daemon.json or
 * /etc/hosts: Incus would keep the write inside the container anyway, but
 * the link is not the file we mean to change.
 */
export async function writeDockerConfig(
	client: FilesClient,
	name: string,
	config: WorkspaceDockerConfig,
	opts: { caPath: string; log: Logger },
	signal?: AbortSignal,
): Promise<void> {
	const dir = await readText(client, name, "/etc/docker", signal);
	if (dir?.type !== "directory") {
		throw new Error("/etc/docker is not a directory");
	}
	const daemon = await readText(client, name, DAEMON_JSON_PATH, signal);
	if (daemon && daemon.type !== "file") {
		throw new Error(`${DAEMON_JSON_PATH} is not a regular file`);
	}
	const hosts = await readText(client, name, HOSTS_PATH, signal);
	if (hosts && hosts.type !== "file") {
		throw new Error(`${HOSTS_PATH} is not a regular file`);
	}
	await client.pushFile(
		name,
		DAEMON_JSON_PATH,
		mergeDaemonJson(daemon?.text ?? null, config.hubMirror),
		ROOT_FILE,
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
			await client.pushFile(
				name,
				d,
				"",
				{ uid: 0, gid: 0, mode: "0755", type: "directory" },
				signal,
			);
		}
		await client.pushFile(name, GHCR_CERT_PATH, ca, ROOT_FILE, signal);
	} else {
		try {
			await client.deleteFile(name, GHCR_CERT_PATH, signal);
		} catch (err) {
			if (!(err instanceof IncusError && err.code === "NOT_FOUND")) throw err;
		}
	}

	if (hosts === null && !ghcr) return;
	const text = hosts?.text ?? "";
	const next = hostsWithGhcr(text, ghcr);
	if (next !== text) {
		await client.pushFile(name, HOSTS_PATH, next, ROOT_FILE, signal);
	}
}
