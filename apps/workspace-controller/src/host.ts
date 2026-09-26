import { readFile } from "node:fs/promises";
import type {
	GrowVolumesRequest,
	GrowVolumesResponse,
	HostSnapshot,
} from "@portikus/contracts";
import { createHostRateReader } from "./host-rates.js";
import { type IncusClient, IncusError } from "./incus.js";

// One reader per controller process, so each snapshot is a delta against the last.
const readHostRates = createHostRateReader();

export type LoadAverage = [number, number, number];

/** The 1, 5 and 15 minute load averages of the VM the controller runs on. */
export async function readLoadAverage(path = "/proc/loadavg"): Promise<LoadAverage> {
	const text = await readFile(path, "utf8");
	const [one, five, fifteen] = text.trim().split(/\s+/).map(Number);
	if (![one, five, fifteen].every((n) => Number.isFinite(n) && (n as number) >= 0)) {
		throw new IncusError("OPERATION_FAILED", `unreadable load average in ${path}`);
	}
	return [one as number, five as number, fifteen as number];
}

function enc(name: string): string {
	return encodeURIComponent(name);
}

function str(value: unknown): string | null {
	return typeof value === "string" && value !== "" ? value : null;
}

function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * Take one look at the host for the admin Health tab (SPEC.md §25.6). Every
 * query is a read; the shapes were confirmed on the pilot (Epic 11 task 2).
 */
export async function readHostSnapshot(
	client: IncusClient,
	opts: {
		pool: string;
		profile: string;
		imageAlias: string;
		loadAverage?: () => Promise<LoadAverage>;
		rates?: () => Promise<HostSnapshot["rates"]>;
		now?: () => Date;
	},
): Promise<HostSnapshot> {
	const loadAverage = await (opts.loadAverage ?? readLoadAverage)();

	const resources = (await client.request("GET", "/1.0/resources")) as {
		cpu?: { total?: number };
		memory?: { used?: number; total?: number };
	};
	const poolResources = (await client.request(
		"GET",
		`/1.0/storage-pools/${enc(opts.pool)}/resources`,
	)) as { space?: { used?: number; total?: number } };
	const profile = (await client.request(
		"GET",
		`/1.0/profiles/${enc(opts.profile)}`,
	)) as { config?: Record<string, unknown> };
	const image = await readCurrentImage(client, opts.imageAlias);
	const instances = (await client.request(
		"GET",
		"/1.0/instances?recursion=1",
	)) as Array<{
		name: string;
		config?: Record<string, unknown>;
	}>;

	return {
		observedAt: (opts.now ?? (() => new Date()))().toISOString(),
		loadAverage,
		cpuCount: Math.max(1, num(resources.cpu?.total)),
		memory: {
			usedBytes: num(resources.memory?.used),
			totalBytes: num(resources.memory?.total),
		},
		pool: {
			name: opts.pool,
			usedBytes: num(poolResources.space?.used),
			totalBytes: num(poolResources.space?.total),
		},
		profileLimits: {
			cpu: str(profile.config?.["limits.cpu"]),
			memory: str(profile.config?.["limits.memory"]),
			processes: str(profile.config?.["limits.processes"]),
		},
		image,
		instances: instances.map((inst) => ({
			name: inst.name,
			imageFingerprint: str(inst.config?.["volatile.base_image"]),
			imageSerial: str(inst.config?.["image.serial"]),
		})),
		rates: await (opts.rates ?? readHostRates)(),
	};
}

/** The image the alias points to, or nulls when the alias is missing. */
async function readCurrentImage(
	client: IncusClient,
	alias: string,
): Promise<HostSnapshot["image"]> {
	let fingerprint: string;
	try {
		const target = (await client.request(
			"GET",
			`/1.0/images/aliases/${enc(alias)}`,
		)) as {
			target?: unknown;
		};
		const value = str(target.target);
		if (value === null) return { fingerprint: null, serial: null };
		fingerprint = value;
	} catch (err) {
		if (err instanceof IncusError && err.code === "NOT_FOUND") {
			return { fingerprint: null, serial: null };
		}
		throw err;
	}
	const details = (await client.request("GET", `/1.0/images/${enc(fingerprint)}`)) as {
		properties?: Record<string, unknown>;
	};
	return { fingerprint, serial: str(details.properties?.serial) };
}

const UNIT_BYTES: Record<string, number> = {
	"": 1,
	B: 1,
	kB: 1e3,
	KB: 1e3,
	MB: 1e6,
	GB: 1e9,
	TB: 1e12,
	KiB: 2 ** 10,
	MiB: 2 ** 20,
	GiB: 2 ** 30,
	TiB: 2 ** 40,
};

/** Bytes in an Incus size string such as "25GiB", or null if it is not one. */
export function parseIncusSize(size: unknown): number | null {
	if (typeof size !== "string") return null;
	const match = /^\s*(\d+(?:\.\d+)?)\s*([A-Za-z]*)\s*$/.exec(size);
	const factor = match ? UNIT_BYTES[match[2] as string] : undefined;
	if (!match || factor === undefined) return null;
	return Number(match[1]) * factor;
}

/**
 * Grow a workspace's home and Docker volumes (SPEC.md §20.1). Both sizes are
 * checked before either volume changes, so a shrink leaves both untouched.
 * A volume already at the requested size is left alone, which makes a retry
 * after a partial failure safe. On the pilot's LVM thin pool the filesystem
 * grows while the instance runs.
 */
export async function growVolumes(
	client: IncusClient,
	pool: string,
	name: string,
	sizes: GrowVolumesRequest,
): Promise<GrowVolumesResponse> {
	const wanted = [
		{ volume: `${name}-home`, gib: sizes.homeGiB },
		{ volume: `${name}-docker`, gib: sizes.dockerGiB },
	];
	const path = (volume: string) =>
		`/1.0/storage-pools/${enc(pool)}/volumes/custom/${enc(volume)}`;

	const current: Array<number | null> = [];
	for (const { volume, gib } of wanted) {
		const info = (await client.request("GET", path(volume))) as {
			config?: Record<string, unknown>;
		};
		const size = info.config?.size;
		const bytes = parseIncusSize(size);
		// A size we cannot read might be larger than the request, so do not risk a shrink.
		if (size !== undefined && size !== "" && bytes === null) {
			throw new IncusError(
				"OPERATION_FAILED",
				`The current size of ${volume} could not be read.`,
			);
		}
		if (bytes !== null && gib * 2 ** 30 < bytes) {
			throw new IncusError("BAD_REQUEST", "Storage can only be increased.");
		}
		current.push(bytes);
	}

	for (const [i, { volume, gib }] of wanted.entries()) {
		if (current[i] === gib * 2 ** 30) continue;
		// PATCH merges into the volume's config, so its volatile keys survive.
		await client.request("PATCH", path(volume), { config: { size: `${gib}GiB` } });
	}

	return { homeGiB: sizes.homeGiB, dockerGiB: sizes.dockerGiB };
}

/**
 * Bytes of reclaimable file cache (`inactive_file`) in an instance's cgroup.
 * Incus reports `memory.current`, which counts page cache, so the resource
 * guard subtracts this to get the working set (ADR 0032).
 */
export async function readInactiveFileBytes(
	project: string,
	instance: string,
	cgroupRoot = "/sys/fs/cgroup",
): Promise<number> {
	// Incus leaves the project out of the cgroup name for the default project.
	const scope = project === "default" ? instance : `${project}_${instance}`;
	const path = `${cgroupRoot}/lxc.payload.${scope}/memory.stat`;
	const text = await readFile(path, "utf8");
	const match = /^inactive_file (\d+)$/m.exec(text);
	if (!match) {
		throw new IncusError("OPERATION_FAILED", `no inactive_file in ${path}`);
	}
	return Number(match[1]);
}

/**
 * The number of CPUs in an Incus `limits.cpu` value: a count such as "4",
 * or a CPU set such as "0-3" or "0,2". Null when unset or unreadable.
 */
export function countIncusCpus(value: unknown): number | null {
	if (typeof value !== "string" || value.trim() === "") return null;
	const text = value.trim();
	if (/^\d+$/.test(text)) {
		const n = Number(text);
		return n > 0 ? n : null;
	}
	let count = 0;
	for (const part of text.split(",")) {
		const range = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
		if (!range) return null;
		const first = Number(range[1]);
		const last = range[2] === undefined ? first : Number(range[2]);
		if (last < first) return null;
		count += last - first + 1;
	}
	return count;
}
