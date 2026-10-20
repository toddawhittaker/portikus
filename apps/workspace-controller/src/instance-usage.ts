// Resource guard reads and limits: usage, processes, CPU allowance and instance limits (ADR 0032, ADR 0037).
import { setTimeout as sleep } from "node:timers/promises";
import {
	type AddedPackagesResponse,
	CpuAllowance,
	countIncusCpus,
	type InstanceProcess,
	type InstanceUsage,
	parseAptList,
	type SetInstanceLimitsRequest,
} from "@portikus/contracts";
import { errorMessage } from "@portikus/observability";
import { parseIncusSize, readInactiveFileBytes } from "./host.js";
import { IncusError } from "./incus.js";
import { parseIdmap, readInstanceProcesses } from "./processes.js";
import {
	enc,
	type InstanceConfig,
	type ProviderHost,
	validateName,
	writableFields,
} from "./provider-host.js";
import { STUDENT_UID } from "./start-setup.js";

/** Where the image's apt hook writes the packages the student added. */
const ADDED_PACKAGES_PATH = "/home/student/.portikus/apt-packages.txt";

/** The most the controller reads of that file. */
export const ADDED_PACKAGES_MAX_BYTES = 64 * 1024;

/** How long a command the controller runs inside a container may take before `timeout` ends it. */
const IN_CONTAINER_SECONDS = 10;

/** The Incus key the resource guard throttles with (ADR 0032). */
const CPU_ALLOWANCE_KEY = "limits.cpu.allowance";

export async function setCpuAllowance(
	host: ProviderHost,
	name: string,
	allowance: string | null,
	signal?: AbortSignal,
): Promise<void> {
	validateName(name);
	// Checked again here: a percentage is only a soft share (ADR 0032).
	if (allowance !== null && !CpuAllowance.safeParse(allowance).success) {
		throw new IncusError("BAD_REQUEST", `invalid cpu allowance: ${allowance}`);
	}
	await writeCpuAllowance(host, name, allowance, signal);
	host.log.info({ instance: name, allowance }, "cpu allowance set");
}

/**
 * PATCH cannot remove a config key, so write the instance back as read,
 * with only the allowance changed, guarded by the ETag.
 */
export async function writeCpuAllowance(
	host: ProviderHost,
	name: string,
	allowance: string | null,
	signal?: AbortSignal,
): Promise<string | undefined> {
	const path = `/1.0/instances/${enc(name)}`;
	const { metadata, etag } = await host.client.getWithEtag(path, signal);
	const inst = metadata as InstanceConfig;
	const { [CPU_ALLOWANCE_KEY]: current, ...config } = inst.config ?? {};
	if ((current ?? null) === allowance) {
		return inst.status;
	}
	if (allowance !== null) {
		config[CPU_ALLOWANCE_KEY] = allowance;
	}
	await host.client.putIfMatch(path, { ...writableFields(inst), config }, etag, signal);
	return inst.status;
}

/**
 * One Incus listing for the resource guard (ADR 0032). Totals only: no
 * process, command line or file name is read (SPEC.md 20.1).
 */
export async function instanceUsage(
	host: ProviderHost,
	signal?: AbortSignal,
): Promise<InstanceUsage[]> {
	const instances = (await host.client.request(
		"GET",
		"/1.0/instances?recursion=2",
		undefined,
		signal,
	)) as Array<{
		name: string;
		status: string;
		config?: Record<string, string>;
		expanded_config?: Record<string, string>;
		state?: {
			pid?: number;
			cpu?: { usage?: number };
			memory?: { usage?: number; total?: number };
		};
	}>;

	const result: InstanceUsage[] = [];
	for (const inst of instances) {
		if (inst.status !== "Running") continue;
		const expanded = inst.expanded_config ?? {};
		const memoryLimitBytes =
			parseIncusSize(expanded["limits.memory"]) ?? inst.state?.memory?.total ?? 0;
		if (!(memoryLimitBytes > 0)) {
			host.log.warn({ instance: inst.name }, "no memory limit; usage skipped");
			continue;
		}
		result.push({
			name: inst.name,
			cpuUsageNs: Math.max(0, Math.trunc(inst.state?.cpu?.usage ?? 0)),
			bootMarker: (inst.state?.pid ?? 0) > 0 ? Math.trunc(inst.state?.pid ?? 0) : null,
			cpuLimit: countIncusCpus(expanded["limits.cpu"]) ?? host.hostCpuCount,
			memoryBytes: await workingSetBytes(
				host,
				inst.name,
				inst.state?.memory?.usage ?? 0,
			),
			memoryLimitBytes: Math.trunc(memoryLimitBytes),
			cpuAllowance: expanded[CPU_ALLOWANCE_KEY] ?? null,
		});
	}
	return result;
}

/**
 * Read the instance's processes from the host's /proc and cgroup tree
 * (ADR 0037). Nothing runs inside the instance and nothing is written.
 */
export async function instanceProcesses(
	host: ProviderHost,
	name: string,
	signal?: AbortSignal,
): Promise<InstanceProcess[]> {
	validateName(name);
	const inst = (await host.client.request(
		"GET",
		`/1.0/instances/${enc(name)}`,
		undefined,
		signal,
	)) as { config?: Record<string, string>; expanded_config?: Record<string, string> };
	const state = (await host.client.request(
		"GET",
		`/1.0/instances/${enc(name)}/state`,
		undefined,
		signal,
	)) as { status?: string; pid?: number };
	const initPid = state.pid ?? 0;
	if (state.status !== "Running" || !(initPid > 0)) {
		throw new IncusError("OPERATION_FAILED", `instance ${name} is not running`);
	}
	const scope =
		host.client.project === "default" ? name : `${host.client.project}_${name}`;
	try {
		return await readInstanceProcesses({
			procRoot: host.procRoot,
			cgroupDir: `${host.cgroupRoot}/lxc.payload.${scope}`,
			initPid,
			idmap: parseIdmap(inst.config?.["volatile.idmap.current"]),
			cpuLimit:
				countIncusCpus(inst.expanded_config?.["limits.cpu"]) ?? host.hostCpuCount,
			wait: () => sleep(1000, undefined, { signal }),
			signal,
		});
	} catch (err) {
		if (signal?.aborted) throw err;
		throw new IncusError(
			"OPERATION_FAILED",
			err instanceof Error ? err.message : "could not read processes",
		);
	}
}

/**
 * Incus's memory usage counts page cache, so take out the reclaimable
 * part (ADR 0032). If the cgroup cannot be read, report the raw figure.
 */
async function workingSetBytes(
	host: ProviderHost,
	name: string,
	usage: number,
): Promise<number> {
	try {
		const inactive = await readInactiveFileBytes(
			host.client.project,
			name,
			host.cgroupRoot,
		);
		return Math.max(0, Math.trunc(usage - inactive));
	} catch (err) {
		host.log.warn(
			{ instance: name, err: errorMessage(err) },
			"could not read the instance's memory.stat; reporting usage with cache",
		);
		return Math.max(0, Math.trunc(usage));
	}
}

/**
 * Set the instance's own limits, never the profile's; Incus applies them
 * live to a running container. Null removes the key so the profile applies.
 */
export async function setInstanceLimits(
	host: ProviderHost,
	name: string,
	limits: SetInstanceLimitsRequest,
	signal?: AbortSignal,
): Promise<void> {
	validateName(name);
	if (limits.cpu !== null && limits.cpu > host.hostCpuCount) {
		throw new IncusError(
			"BAD_REQUEST",
			`the host has ${host.hostCpuCount} CPUs; ${limits.cpu} is more`,
		);
	}
	const wanted: Record<string, string | null> = {
		"limits.cpu": limits.cpu === null ? null : String(limits.cpu),
		"limits.memory": limits.memoryMiB === null ? null : `${limits.memoryMiB}MiB`,
		"limits.processes": limits.processes === null ? null : String(limits.processes),
	};
	const path = `/1.0/instances/${enc(name)}`;
	const { metadata, etag } = await host.client.getWithEtag(path, signal);
	const inst = metadata as InstanceConfig;
	const config = { ...(inst.config ?? {}) };
	let changed = false;
	for (const [key, value] of Object.entries(wanted)) {
		if ((config[key] ?? null) === value) continue;
		changed = true;
		if (value === null) delete config[key];
		else config[key] = value;
	}
	if (!changed) return;
	// PATCH cannot remove a config key, so write back as read, ETag-guarded.
	await host.client.putIfMatch(path, { ...writableFields(inst), config }, etag, signal);
	host.log.info({ instance: name, ...limits }, "instance limits set");
}

/**
 * Read the apt hook's list from inside the running container, as the
 * student, so a named pipe or link planted there blocks or leaks nothing
 * outside it (SPEC.md §24). Anything but a regular file, or a read that
 * fails, is no list.
 */
export async function readAddedPackages(
	host: ProviderHost,
	name: string,
	signal?: AbortSignal,
): Promise<AddedPackagesResponse> {
	validateName(name);
	const read = await host.client.exec(
		name,
		[
			"timeout",
			String(IN_CONTAINER_SECONDS),
			"sh",
			"-c",
			'[ -f "$1" ] || exit 3; exec head -c "$2" -- "$1"',
			"sh",
			ADDED_PACKAGES_PATH,
			String(ADDED_PACKAGES_MAX_BYTES + 1),
		],
		{
			timeoutSeconds: IN_CONTAINER_SECONDS + 5,
			user: STUDENT_UID,
			outputMaxBytes: ADDED_PACKAGES_MAX_BYTES,
		},
		signal,
	);
	if (read.tooLarge) {
		throw new IncusError("BAD_REQUEST", "the added-packages list is over 64 KiB");
	}
	if (read.status !== 0) return { image: null, packages: [] };
	const { image, packages } = parseAptList(read.stdout.toString("utf8"));
	return { image, packages };
}
