import { access, readFile } from "node:fs/promises";
import {
	HUB_MIRROR_URL,
	REGISTRY_GATEWAY_ADDR,
	type WorkspaceDockerConfig,
} from "@portikus/contracts";
import { errorMessage, type Logger } from "@portikus/observability";
import { type IncusClient, IncusError } from "./incus.js";

/**
 * What the controller writes into a workspace's Docker setup: the Hub
 * cache as a registry mirror, and while the ghcr.io cache is on, a hosts
 * entry and the CA Docker trusts for it. The controller never reads these
 * files, since Incus cannot tell it a student's named pipe from a file
 * (SPEC.md §24): daemon.json is written whole while the container is
 * stopped, and the hosts line is edited by a bounded command inside the
 * running container, which keeps the student's own lines.
 */

const DAEMON_JSON_PATH = "/etc/docker/daemon.json";
const GHCR_CERT_DIR = "/etc/docker/certs.d/ghcr.io";
export const GHCR_CERT_PATH = `${GHCR_CERT_DIR}/ca.crt`;
/** The CA the root cache helper made; public, readable by the controller. */
export const GHCR_CA_HOST_PATH = "/etc/portikus/registry/ghcr-ca.crt";
/** Setup writes this when the pull cache does not fit on disk (SPEC.md 16.6). */
export const CACHE_OFF_HOST_PATH = "/etc/portikus/registry/cache-off";
/** Marks the one hosts line the controller owns. */
export const GHCR_HOSTS_MARKER = "# portikus-ghcr-cache";
const HOSTS_PATH = "/etc/hosts";
/** How long the in-container hosts edit may run before `timeout` ends it. */
const HOSTS_EDIT_SECONDS = 10;

/** The image's daemon.json (the overlay2 pin of SPEC.md 16.2) with our mirror when on. */
export function daemonJson(hubMirror: boolean): string {
	const config: Record<string, unknown> = {
		"storage-driver": "overlay2",
		features: { "containerd-snapshotter": false },
	};
	if (hubMirror) config["registry-mirrors"] = [HUB_MIRROR_URL];
	return `${JSON.stringify(config, null, 2)}\n`;
}

/**
 * Rewrites the hosts file at $3 without lines matching $2, adding $1 when
 * set. Anything but a regular file there is replaced by a fresh hosts file.
 * The result is renamed into place, so a pipe or link is never written
 * through, and a read that blocks is ended by `timeout` with its group.
 */
export const HOSTS_EDIT_SCRIPT = [
	'f="$3"',
	't=$(mktemp "$f.portikus.XXXXXX") || exit 4',
	"trap 'rm -f \"$t\"; exit 124' TERM",
	'if [ -f "$f" ]; then grep -v -e "$2" "$f" > "$t"; [ $? -le 1 ] || { rm -f "$t"; exit 5; }',
	'else printf \'127.0.0.1\\tlocalhost\\n::1\\tlocalhost ip6-localhost ip6-loopback\\n127.0.1.1\\t%s\\n\' "$(hostname)" > "$t"; fi',
	'[ -z "$1" ] || printf \'%s\\n\' "$1" >> "$t"',
	'chmod 0644 "$t" && mv -fT "$t" "$f"',
].join("\n");

type FilesClient = Pick<IncusClient, "pushFile" | "replaceFile" | "deleteFile">;

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

const ROOT_FILE = { uid: 0, gid: 0, mode: "0644" } as const;
const ROOT_DIR = { uid: 0, gid: 0, mode: "0755", type: "directory" } as const;

/**
 * Write daemon.json and the ghcr.io CA into a stopped workspace, so dockerd
 * reads them at boot. Returns whether the ghcr.io cache is on; the hosts
 * line follows after the start (`writeGhcrHosts`).
 */
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
	// Incus answers success whatever already sits at the folder path; a
	// non-folder there makes the file replace below fail instead.
	await client.pushFile(name, "/etc/docker", "", ROOT_DIR, signal);
	await client.replaceFile(
		name,
		DAEMON_JSON_PATH,
		daemonJson(config.hubMirror),
		ROOT_FILE,
		signal,
	);

	let ca: string | null = null;
	if (config.ghcr) {
		try {
			ca = await readFile(opts.caPath, "utf8");
		} catch (err) {
			opts.log.warn(
				{ instance: name, err: errorMessage(err) },
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
		await client.replaceFile(name, GHCR_CERT_PATH, ca, ROOT_FILE, signal);
	} else {
		try {
			await client.deleteFile(name, GHCR_CERT_PATH, signal);
		} catch (err) {
			if (!(err instanceof IncusError && err.code === "NOT_FOUND")) throw err;
		}
	}

	return ghcr;
}

/**
 * Add or remove our ghcr.io line in a running workspace's /etc/hosts. Runs
 * after the start, so the image's create/copy template, which rewrites
 * /etc/hosts at the first start, cannot drop the line.
 */
export async function writeGhcrHosts(
	client: Pick<IncusClient, "exec">,
	name: string,
	ghcr: boolean,
	signal?: AbortSignal,
): Promise<void> {
	const line = ghcr ? `${REGISTRY_GATEWAY_ADDR} ghcr.io ${GHCR_HOSTS_MARKER}` : "";
	const { status } = await client.exec(
		name,
		[
			"timeout",
			String(HOSTS_EDIT_SECONDS),
			"sh",
			"-c",
			HOSTS_EDIT_SCRIPT,
			"sh",
			line,
			`${GHCR_HOSTS_MARKER}$`,
			HOSTS_PATH,
		],
		{ timeoutSeconds: HOSTS_EDIT_SECONDS + 5 },
		signal,
	);
	if (status !== 0) throw new Error(`the /etc/hosts edit exited ${status}`);
}
