import { availableParallelism } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import {
	type AddedPackagesResponse,
	AGENT_RESTART_TIMEOUT_SECONDS,
	type CreateInstanceResponse,
	type GrowVolumesRequest,
	type GrowVolumesResponse,
	type HostSnapshot,
	INSTANCE_CREATE_WAIT_SECONDS,
	type InstanceProcess,
	type InstanceStatus,
	type InstanceUsage,
	type KeptVolumesResponse,
	POOL_FULL_PERCENT,
	poolFillPercent,
	type RebuildInstanceResponse,
	type ReplaceHomeResponse,
	type SeedInfo,
	type SetInstanceLimitsRequest,
	type StartInstanceResponse,
	type StopInstanceResponse,
	VOLUME_CREATE_TIMEOUT_MS,
	type WorkspaceDockerConfig,
} from "@portikus/contracts";
import { type Logger, silentLogger } from "@portikus/observability";
import {
	AGENT_INSTRUCTIONS_HOST_PATH,
	CLAUDE_MANAGED_SETTINGS_HOST_PATH,
} from "./agent-instructions.js";
import type { RunningAgent } from "./agent-restart.js";
import { CODING_AGENTS_HOST_BIN } from "./coding-agent-links.js";
import { CACHE_OFF_HOST_PATH, GHCR_CA_HOST_PATH } from "./docker-config.js";
import { ensureDockerVolume, readSeedInfo, seedBytesFor } from "./docker-volume.js";
import {
	ensureVolume,
	growVolumes,
	readHostSnapshot,
	readPoolUse,
	volumePath,
} from "./host.js";
import { type IncusClient, IncusError } from "./incus.js";
import { startInstance } from "./instance-start.js";
import {
	instanceProcesses,
	instanceUsage,
	readAddedPackages,
	setCpuAllowance,
	setInstanceLimits,
} from "./instance-usage.js";
import {
	deleteKeptHome,
	deletePreChangeSnapshot,
	listKeptVolumes,
	replaceHome,
} from "./kept-volumes.js";
import { readUnitStartTime } from "./processes.js";
import {
	assertStopped,
	dockerDevice,
	enc,
	homeDevice,
	type InstanceConfig,
	instanceStatus,
	type ProviderHost,
	recoveryDevice,
	validateName,
	writableFields,
} from "./provider-host.js";

// jscpd:ignore-start -- the worker's client mirrors this interface across HTTP.
export interface WorkspaceProvider {
	/** The current Docker seed, or null when none is built. */
	seedInfo(signal?: AbortSignal): Promise<SeedInfo | null>;
	/** Stops early, making nothing more, once `signal` aborts (ADR 0034). */
	create(
		name: string,
		sizes: { homeGiB: number; dockerGiB: number; recoveryGiB: number },
		signal?: AbortSignal,
	): Promise<CreateInstanceResponse>;
	start(
		name: string,
		opts: {
			timeoutSeconds: number;
			agentToken: string;
			hostname: string;
			previewHostSuffix: string;
			timezone: string;
			dockerGiB?: number;
			recoveryGiB?: number;
			cpuAllowance?: string;
			docker?: WorkspaceDockerConfig;
		},
		signal?: AbortSignal,
	): Promise<StartInstanceResponse>;
	stop(
		name: string,
		opts: { timeoutSeconds: number },
		signal?: AbortSignal,
	): Promise<StopInstanceResponse>;
	list(signal?: AbortSignal): Promise<InstanceStatus[]>;
	healthy(): Promise<boolean>;
	/** Replace the Docker volume with a clean one; the instance must be stopped. */
	resetDocker(
		name: string,
		opts: { dockerGiB: number },
		signal?: AbortSignal,
	): Promise<void>;
	/** Replace the root filesystem from the current image; the instance must be stopped. */
	rebuild(
		name: string,
		opts: { resetDocker: boolean; dockerGiB: number },
		signal?: AbortSignal,
	): Promise<RebuildInstanceResponse>;
	/** One read-only look at the host for the admin Health tab (SPEC.md §25.6). */
	hostSnapshot(signal?: AbortSignal): Promise<HostSnapshot>;
	/** Grow the home and Docker volumes; a smaller size is refused (SPEC.md §20.1). */
	growVolumes(
		name: string,
		sizes: GrowVolumesRequest,
		signal?: AbortSignal,
	): Promise<GrowVolumesResponse>;
	/** CPU time and memory of every running instance, from Incus (ADR 0032). */
	usage(signal?: AbortSignal): Promise<InstanceUsage[]>;
	/** Set or, with null, remove `limits.cpu.allowance` (ADR 0032). */
	setCpuAllowance(
		name: string,
		allowance: string | null,
		signal?: AbortSignal,
	): Promise<void>;
	/** The heaviest processes of a running instance, short names only (ADR 0037). */
	processes(name: string, signal?: AbortSignal): Promise<InstanceProcess[]>;
	/** Set or, with null, remove the instance's own CPU, memory and process limits. */
	setLimits(
		name: string,
		limits: SetInstanceLimitsRequest,
		signal?: AbortSignal,
	): Promise<void>;
	/** The packages the student added, from the apt hook's list in their home. */
	addedPackages(name: string, signal?: AbortSignal): Promise<AddedPackagesResponse>;
	/** Pre-change snapshots and homes kept by Replace home. */
	keptVolumes(signal?: AbortSignal): Promise<KeptVolumesResponse>;
	/** Delete one `pre-*` snapshot of a workspace volume. */
	deleteSnapshot(volume: string, snapshot: string, signal?: AbortSignal): Promise<void>;
	/** Delete one kept home that nothing uses. */
	deleteKeptHome(volume: string, signal?: AbortSignal): Promise<void>;
	/** Swap `<name>-home-import` in as the home and keep the old one; stopped only. */
	replaceHome(name: string, signal?: AbortSignal): Promise<ReplaceHomeResponse>;
}
// jscpd:ignore-end

/** How long to wait for Incus to replace a root filesystem. */
const REBUILD_TIMEOUT_SECONDS = 600;

// The controller's own timeouts live in @portikus/contracts so the worker's budgets derive from them.
export { INSTANCE_CREATE_WAIT_SECONDS, VOLUME_CREATE_TIMEOUT_MS };

export class IncusWorkspaceProvider implements WorkspaceProvider {
	private readonly host: ProviderHost;

	constructor(opts: {
		client: IncusClient;
		pool: string;
		profile: string;
		imageAlias: string;
		agentPort: number;
		logger?: Logger;
		/** Where the host's cgroup tree is mounted; tests point it elsewhere. */
		cgroupRoot?: string;
		/** Where the host's /proc is mounted; tests point it elsewhere. */
		procRoot?: string;
		/** CPUs on the host, for an instance with no `limits.cpu`. */
		hostCpuCount?: number;
		/** The lvm role's status file; tests point it elsewhere. */
		thinPoolStatusPath?: string;
		/** The ghcr.io cache's CA on the host; tests point it elsewhere. */
		ghcrCaPath?: string;
		cacheOffPath?: string;
		/** The agent instructions template on the host; tests point it elsewhere. */
		agentInstructionsPath?: string;
		/** Claude Code's managed settings template on the host; tests point it elsewhere. */
		claudeManagedSettingsPath?: string;
		/** The shared coding-agent tools on the host; tests point it elsewhere. */
		codingAgentsBinPath?: string;
	}) {
		this.host = {
			client: opts.client,
			pool: opts.pool,
			profile: opts.profile,
			imageAlias: opts.imageAlias,
			agentPort: opts.agentPort,
			log: opts.logger ?? silentLogger(),
			cgroupRoot: opts.cgroupRoot ?? "/sys/fs/cgroup",
			procRoot: opts.procRoot ?? "/proc",
			hostCpuCount: opts.hostCpuCount ?? availableParallelism(),
			thinPoolStatusPath: opts.thinPoolStatusPath,
			ghcrCaPath: opts.ghcrCaPath ?? GHCR_CA_HOST_PATH,
			cacheOffPath: opts.cacheOffPath ?? CACHE_OFF_HOST_PATH,
			agentInstructionsPath: opts.agentInstructionsPath ?? AGENT_INSTRUCTIONS_HOST_PATH,
			claudeManagedSettingsPath:
				opts.claudeManagedSettingsPath ?? CLAUDE_MANAGED_SETTINGS_HOST_PATH,
			codingAgentsBinPath: opts.codingAgentsBinPath ?? CODING_AGENTS_HOST_BIN,
		};
	}

	async create(
		name: string,
		sizes: { homeGiB: number; dockerGiB: number; recoveryGiB: number },
		signal?: AbortSignal,
	): Promise<CreateInstanceResponse> {
		validateName(name);

		// Refuse before any volume is made; start, stop, rebuild and adopting an
		// instance that already exists are never refused.
		if (!(await this.instanceExists(name, signal))) {
			const use = await readPoolUse(
				this.host.client,
				this.host.pool,
				new Date(),
				this.host.thinPoolStatusPath,
				signal,
			);
			let fill = poolFillPercent(use);
			// A seeded Docker volume will fill the pool by up to the seed's size.
			if (fill < POOL_FULL_PERCENT) {
				const seedBytes = await seedBytesFor(this.host, name, signal);
				fill = poolFillPercent({ ...use, usedBytes: use.usedBytes + seedBytes });
			}
			if (fill >= POOL_FULL_PERCENT) {
				throw new IncusError(
					"POOL_FULL",
					`storage pool is ${Math.floor(fill)}% full; new workspaces are refused`,
				);
			}
		}

		await ensureVolume(
			this.host.client,
			this.host.pool,
			`${name}-home`,
			sizes.homeGiB,
			{},
			signal,
		);
		await ensureDockerVolume(this.host, name, sizes.dockerGiB, signal);
		await ensureVolume(
			this.host.client,
			this.host.pool,
			`${name}-recovery`,
			sizes.recoveryGiB,
			{},
			signal,
		);

		const imageFingerprint = await this.imageFingerprint(signal);
		const quota = { homeGiB: sizes.homeGiB, dockerGiB: sizes.dockerGiB };

		try {
			await this.host.client.request(
				"POST",
				"/1.0/instances",
				{
					name,
					source: { type: "image", alias: this.host.imageAlias },
					profiles: [this.host.profile],
					devices: {
						home: homeDevice(this.host, name),
						docker: dockerDevice(this.host, name),
						recovery: recoveryDevice(this.host, name),
					},
				},
				signal,
				INSTANCE_CREATE_WAIT_SECONDS,
			);
		} catch (err) {
			if (err instanceof IncusError && err.code === "ALREADY_EXISTS") {
				return { created: false, imageFingerprint, quota };
			}
			throw err;
		}

		return { created: true, imageFingerprint, quota };
	}

	private async instanceExists(name: string, signal?: AbortSignal): Promise<boolean> {
		try {
			await this.host.client.request(
				"GET",
				`/1.0/instances/${enc(name)}`,
				undefined,
				signal,
			);
			return true;
		} catch (err) {
			if (err instanceof IncusError && err.code === "NOT_FOUND") return false;
			throw err;
		}
	}

	private async imageFingerprint(signal?: AbortSignal): Promise<string> {
		try {
			const alias = (await this.host.client.request(
				"GET",
				`/1.0/images/aliases/${enc(this.host.imageAlias)}`,
				undefined,
				signal,
			)) as { target: string };
			return alias.target;
		} catch (err) {
			if (err instanceof IncusError && err.code === "NOT_FOUND") {
				throw new IncusError(
					"IMAGE_NOT_FOUND",
					`image alias ${this.host.imageAlias} not found`,
				);
			}
			throw err;
		}
	}

	async start(
		name: string,
		opts: {
			timeoutSeconds: number;
			agentToken: string;
			hostname: string;
			previewHostSuffix: string;
			timezone: string;
			dockerGiB?: number;
			recoveryGiB?: number;
			cpuAllowance?: string;
			docker?: WorkspaceDockerConfig;
		},
		caller?: AbortSignal,
	): Promise<StartInstanceResponse> {
		return startInstance(this.host, name, opts, caller);
	}

	async stop(
		name: string,
		opts: { timeoutSeconds: number },
		caller?: AbortSignal,
	): Promise<StopInstanceResponse> {
		validateName(name);

		// Stopping an already-stopped instance is a no-op, not a failure.
		// Mid-shutdown this read can fail with "Invalid PID -1";
		// the stop below then settles on the real state.
		const current = await instanceStatus(this.host, name, caller).catch(
			(err: unknown) => {
				if (err instanceof IncusError && err.code === "NOT_FOUND") throw err;
				if (caller?.aborted) throw err;
				return undefined;
			},
		);
		if (current === "Stopped") {
			return { forced: false };
		}

		// Once the graceful stop is sent, it runs through to the forced stop whatever the caller does:
		// a half-done stop would leave a SIGTERM-ignoring workspace running (ADR 0034).
		caller?.throwIfAborted();
		const ownLimit = (opts.timeoutSeconds + 5) * 1000;
		try {
			await this.host.client.request(
				"PUT",
				`/1.0/instances/${enc(name)}/state`,
				{
					action: "stop",
					timeout: opts.timeoutSeconds,
					force: false,
				},
				AbortSignal.timeout(ownLimit),
				opts.timeoutSeconds,
			);
			this.logIfCallerLeft(name, caller);
			return { forced: false };
		} catch {
			try {
				await this.host.client.request(
					"PUT",
					`/1.0/instances/${enc(name)}/state`,
					{
						action: "stop",
						timeout: opts.timeoutSeconds,
						force: true,
					},
					AbortSignal.timeout(ownLimit),
					opts.timeoutSeconds,
				);
			} catch (err) {
				// The instance may already be stopping (Incus then fails with
				// "Invalid PID -1"), so trust the state, not the error.
				if (!(await this.settlesStopped(name, opts.timeoutSeconds))) {
					throw err;
				}
			}
			this.logIfCallerLeft(name, caller);
			return { forced: true };
		}
	}

	private logIfCallerLeft(name: string, caller: AbortSignal | undefined): void {
		if (caller?.aborted) {
			this.host.log.info({ instance: name }, "stop finished after the caller left");
		}
	}

	/** Polls the state for up to `timeoutSeconds` (at most 10) and reports whether it reached Stopped. */
	private async settlesStopped(
		name: string,
		timeoutSeconds: number,
		signal?: AbortSignal,
	): Promise<boolean> {
		const deadline = Date.now() + Math.min(timeoutSeconds, 10) * 1000;
		for (;;) {
			signal?.throwIfAborted();
			if (
				(await instanceStatus(this.host, name, signal).catch(() => null)) === "Stopped"
			) {
				return true;
			}
			if (Date.now() >= deadline) {
				return false;
			}
			await sleep(250, undefined, { signal });
		}
	}

	async list(signal?: AbortSignal): Promise<InstanceStatus[]> {
		const instances = (await this.host.client.request(
			"GET",
			"/1.0/instances?recursion=2",
			undefined,
			signal,
		)) as Array<{
			name: string;
			status: string;
			state?: {
				network?: Record<
					string,
					{
						addresses?: Array<{
							family: string;
							address: string;
							scope: string;
						}>;
					}
				>;
			};
		}>;

		return instances.map((inst) => {
			let status: "Running" | "Stopped" | "Other";
			if (inst.status === "Running") {
				status = "Running";
			} else if (inst.status === "Stopped") {
				status = "Stopped";
			} else {
				status = "Other";
			}

			let ipv4: string | null = null;
			if (inst.state?.network?.eth0) {
				const addr = inst.state.network.eth0.addresses?.find(
					(a) => a.family === "inet" && a.scope === "global",
				);
				if (addr) {
					ipv4 = addr.address;
				}
			}

			return { name: inst.name, status, ipv4 };
		});
	}

	async healthy(): Promise<boolean> {
		return this.host.client.ping();
	}

	/**
	 * Replace the Docker volume with a clean one (SPEC.md 16.4, ADR 0021).
	 *
	 * Each step can be repeated, so a retry finishes a half-done reset: take
	 * the device off, delete the volume, make a new one, put the device back.
	 * The only volume this ever deletes is exactly `<name>-docker`.
	 */
	async resetDocker(
		name: string,
		opts: { dockerGiB: number },
		signal?: AbortSignal,
	): Promise<void> {
		validateName(name);
		const path = `/1.0/instances/${enc(name)}`;
		const dockerVolume = `${name}-docker`;
		const { metadata, etag } = await this.host.client.getWithEtag(path, signal);
		const inst = metadata as InstanceConfig;
		assertStopped(name, inst.status);

		// The PUT below writes back what was read; if home is not in it, what
		// was read is not what we think it is, so touch nothing.
		if (inst.devices?.home?.source !== `${name}-home`) {
			throw new IncusError(
				"OPERATION_FAILED",
				`instance ${name} has no home device on ${name}-home; refusing to reset Docker`,
			);
		}

		const docker = inst.devices.docker;
		if (docker) {
			if (docker.source !== dockerVolume || docker.pool !== this.host.pool) {
				throw new IncusError(
					"OPERATION_FAILED",
					`instance ${name} has an unexpected docker device; refusing to reset Docker`,
				);
			}
			// PATCH cannot remove a device (Incus merges the map), so write the
			// rest back exactly as read, guarded by the ETag.
			const { docker: _removed, ...devices } = inst.devices;
			await this.host.client.putIfMatch(
				path,
				{ ...writableFields(inst), devices },
				etag,
				signal,
			);
		}

		try {
			await this.host.client.request(
				"DELETE",
				volumePath(this.host.pool, dockerVolume),
				undefined,
				signal,
			);
		} catch (err) {
			if (!(err instanceof IncusError && err.code === "NOT_FOUND")) {
				throw err;
			}
		}

		await ensureDockerVolume(this.host, name, opts.dockerGiB, signal);

		await this.host.client.request(
			"PATCH",
			path,
			{ devices: { docker: dockerDevice(this.host, name) } },
			signal,
		);
		this.host.log.info({ instance: name }, "docker volume replaced");
	}

	/**
	 * Replace the root filesystem from the current image (SPEC.md 17.2,
	 * 22.3). Incus keeps the instance's own devices, so home, Docker and
	 * recovery stay attached.
	 */
	async rebuild(
		name: string,
		opts: { resetDocker: boolean; dockerGiB: number },
		signal?: AbortSignal,
	): Promise<RebuildInstanceResponse> {
		validateName(name);
		const inst = (await this.host.client.request(
			"GET",
			`/1.0/instances/${enc(name)}`,
			undefined,
			signal,
		)) as InstanceConfig;
		assertStopped(name, inst.status);

		const imageFingerprint = await this.imageFingerprint(signal);

		if (opts.resetDocker) {
			await this.resetDocker(name, { dockerGiB: opts.dockerGiB }, signal);
		}

		await this.host.client.request(
			"POST",
			`/1.0/instances/${enc(name)}/rebuild`,
			{ source: { type: "image", alias: this.host.imageAlias } },
			signal,
			REBUILD_TIMEOUT_SECONDS,
		);
		this.host.log.info({ instance: name, imageFingerprint }, "instance rebuilt");

		return { imageFingerprint };
	}

	async setCpuAllowance(
		name: string,
		allowance: string | null,
		signal?: AbortSignal,
	): Promise<void> {
		return setCpuAllowance(this.host, name, allowance, signal);
	}

	/**
	 * One Incus listing for the resource guard (ADR 0032). Totals only: no
	 * process, command line or file name is read (SPEC.md 20.1).
	 */
	async usage(signal?: AbortSignal): Promise<InstanceUsage[]> {
		return instanceUsage(this.host, signal);
	}

	/**
	 * Read the instance's processes from the host's /proc and cgroup tree
	 * (ADR 0037). Nothing runs inside the instance and nothing is written.
	 */
	async processes(name: string, signal?: AbortSignal): Promise<InstanceProcess[]> {
		return instanceProcesses(this.host, name, signal);
	}

	async seedInfo(signal?: AbortSignal): Promise<SeedInfo | null> {
		return readSeedInfo(this.host, signal);
	}

	async hostSnapshot(signal?: AbortSignal): Promise<HostSnapshot> {
		return readHostSnapshot(this.host.client, {
			pool: this.host.pool,
			profile: this.host.profile,
			imageAlias: this.host.imageAlias,
			thinPoolStatusPath: this.host.thinPoolStatusPath,
			signal,
		});
	}

	async growVolumes(
		name: string,
		sizes: GrowVolumesRequest,
		signal?: AbortSignal,
	): Promise<GrowVolumesResponse> {
		validateName(name);
		return growVolumes(this.host.client, this.host.pool, name, sizes, signal);
	}

	/**
	 * Set the instance's own limits, never the profile's; Incus applies them
	 * live to a running container. Null removes the key so the profile applies.
	 */
	async setLimits(
		name: string,
		limits: SetInstanceLimitsRequest,
		signal?: AbortSignal,
	): Promise<void> {
		return setInstanceLimits(this.host, name, limits, signal);
	}

	/**
	 * Read the apt hook's list from inside the running container, as the
	 * student, so a named pipe or link planted there blocks or leaks nothing
	 * outside it (SPEC.md §24). Anything but a regular file, or a read that
	 * fails, is no list.
	 */
	async addedPackages(
		name: string,
		signal?: AbortSignal,
	): Promise<AddedPackagesResponse> {
		return readAddedPackages(this.host, name, signal);
	}

	async keptVolumes(signal?: AbortSignal): Promise<KeptVolumesResponse> {
		return listKeptVolumes(this.host, signal);
	}

	async deleteSnapshot(
		volume: string,
		snapshot: string,
		signal?: AbortSignal,
	): Promise<void> {
		return deletePreChangeSnapshot(this.host, volume, snapshot, signal);
	}

	async deleteKeptHome(volume: string, signal?: AbortSignal): Promise<void> {
		return deleteKeptHome(this.host, volume, signal);
	}

	/**
	 * Swap an imported home in the way Reset Docker swaps Docker's: detach
	 * home, keep the old volume under a new name, rename the import, attach.
	 * Each step can be repeated, so a retry finishes a half-done swap.
	 */
	async replaceHome(name: string, signal?: AbortSignal): Promise<ReplaceHomeResponse> {
		return replaceHome(this.host, name, signal);
	}

	/**
	 * Each running instance with its image serial and when its agent started,
	 * both read on the host.
	 */
	async runningAgents(): Promise<RunningAgent[]> {
		const instances = (await this.host.client.request(
			"GET",
			"/1.0/instances?recursion=1",
		)) as Array<{ name: string; status: string; config?: Record<string, string> }>;
		const agents: RunningAgent[] = [];
		for (const inst of instances) {
			if (inst.status !== "Running") continue;
			const scope =
				this.host.client.project === "default"
					? inst.name
					: `${this.host.client.project}_${inst.name}`;
			agents.push({
				name: inst.name,
				imageSerial: inst.config?.["image.serial"] ?? null,
				startedAt: await readUnitStartTime(
					this.host.procRoot,
					`${this.host.cgroupRoot}/lxc.payload.${scope}/system.slice/portikus-workspace-agent.service`,
				),
			});
		}
		return agents;
	}

	/** Restart the agent unit inside a running instance. */
	async restartAgent(name: string): Promise<void> {
		validateName(name);
		const { status } = await this.host.client.exec(
			name,
			["systemctl", "restart", "portikus-workspace-agent.service"],
			{ timeoutSeconds: AGENT_RESTART_TIMEOUT_SECONDS },
		);
		if (status !== null && status !== 0) {
			throw new IncusError("OPERATION_FAILED", `systemctl restart exited ${status}`);
		}
	}
}
