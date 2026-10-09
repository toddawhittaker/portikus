import { availableParallelism } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import {
	type AddedPackagesResponse,
	AGENT_RESTART_TIMEOUT_SECONDS,
	CpuAllowance,
	type CreateInstanceResponse,
	countIncusCpus,
	type GrowVolumesRequest,
	type GrowVolumesResponse,
	type HostSnapshot,
	INSTANCE_CREATE_WAIT_SECONDS,
	InstanceName,
	type InstanceProcess,
	type InstanceStatus,
	type InstanceUsage,
	isSystemTimezone,
	KeptHomeVolumeName,
	type KeptVolumesResponse,
	POOL_FULL_PERCENT,
	PreChangeSnapshotName,
	parseAptList,
	poolFillPercent,
	type RebuildInstanceResponse,
	type ReplaceHomeResponse,
	SEED_VOLUME_NAME,
	SeedInfo,
	type SetInstanceLimitsRequest,
	type StartInstanceResponse,
	type StopInstanceResponse,
	VOLUME_CREATE_TIMEOUT_MS,
	type WorkspaceDockerConfig,
	WorkspaceVolumeName,
} from "@portikus/contracts";
import { errorMessage, type Logger, silentLogger } from "@portikus/observability";
import {
	AGENT_INSTRUCTIONS_HOST_PATH,
	CLAUDE_MANAGED_SETTINGS_HOST_PATH,
	writeAgentInstructions,
	writeClaudeManagedSettings,
} from "./agent-instructions.js";
import type { RunningAgent } from "./agent-restart.js";
import {
	CACHE_OFF_HOST_PATH,
	GHCR_CA_HOST_PATH,
	writeDockerConfig,
	writeGhcrHosts,
} from "./docker-config.js";
import {
	ensureVolume,
	growVolumes,
	parseIncusSize,
	readHostSnapshot,
	readInactiveFileBytes,
	readPoolUse,
	SEED_INFO_KEY,
	SEED_SHARE_KEY,
	VolumeInUseError,
	volumeExists,
	volumePath,
} from "./host.js";
import { type IncusClient, IncusError } from "./incus.js";
import { parseIdmap, readInstanceProcesses, readUnitStartTime } from "./processes.js";
import {
	prepareRecoveryMount,
	RECOVERY_PATH,
	STUDENT_UID,
	setHostname,
	setTimezone,
	waitForAddress,
	waitForAgent,
	withCaller,
	writeStartFiles,
} from "./start-setup.js";

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
	list(): Promise<InstanceStatus[]>;
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
	hostSnapshot(): Promise<HostSnapshot>;
	/** Grow the home and Docker volumes; a smaller size is refused (SPEC.md §20.1). */
	growVolumes(
		name: string,
		sizes: GrowVolumesRequest,
		signal?: AbortSignal,
	): Promise<GrowVolumesResponse>;
	/** CPU time and memory of every running instance, from Incus (ADR 0032). */
	usage(): Promise<InstanceUsage[]>;
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
	keptVolumes(): Promise<KeptVolumesResponse>;
	/** Delete one `pre-*` snapshot of a workspace volume. */
	deleteSnapshot(volume: string, snapshot: string): Promise<void>;
	/** Delete one kept home that nothing uses. */
	deleteKeptHome(volume: string, signal?: AbortSignal): Promise<void>;
	/** Swap `<name>-home-import` in as the home and keep the old one; stopped only. */
	replaceHome(name: string, signal?: AbortSignal): Promise<ReplaceHomeResponse>;
}
// jscpd:ignore-end

/**
 * Refused because the instance is not stopped. The server answers 409, so
 * the worker knows to stop it first (ADR 0021).
 */
export class InstanceNotStoppedError extends IncusError {
	constructor(name: string, status: string) {
		super("OPERATION_FAILED", `instance ${name} is ${status}; stop it first`);
		this.name = "InstanceNotStoppedError";
	}
}

/** Where the image's apt hook writes the packages the student added. */
const ADDED_PACKAGES_PATH = "/home/student/.portikus/apt-packages.txt";

/** The most the controller reads of that file. */
export const ADDED_PACKAGES_MAX_BYTES = 64 * 1024;

/** How long a command the controller runs inside a container may take before `timeout` ends it. */
const IN_CONTAINER_SECONDS = 10;

/** A lowercase DNS label; anything else must never reach the container. */
const HOSTNAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/** A lowercase DNS name, checked again here as defence in depth. */
const DNS_NAME_PATTERN =
	/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/** How long to wait for Incus to replace a root filesystem. */
const REBUILD_TIMEOUT_SECONDS = 600;

/** The Incus key the resource guard throttles with (ADR 0032). */
const CPU_ALLOWANCE_KEY = "limits.cpu.allowance";

/** The fields of an instance that Incus accepts back in a PUT. */
interface InstanceConfig {
	architecture: string;
	config: Record<string, string>;
	devices: Record<string, Record<string, string>>;
	ephemeral: boolean;
	profiles: string[];
	stateful: boolean;
	description: string;
	status?: string;
}

/** An instance as read, reduced to what Incus accepts back in a PUT. */
function writableFields(inst: InstanceConfig): InstanceConfig {
	return {
		architecture: inst.architecture,
		config: inst.config,
		devices: inst.devices,
		ephemeral: inst.ephemeral,
		profiles: inst.profiles,
		stateful: inst.stateful,
		description: inst.description,
	};
}

function assertStopped(name: string, status: string | undefined): void {
	if (status !== "Stopped") {
		throw new InstanceNotStoppedError(name, status ?? "in an unknown state");
	}
}

// The controller's own timeouts live in @portikus/contracts so the worker's budgets derive from them.
export { INSTANCE_CREATE_WAIT_SECONDS, VOLUME_CREATE_TIMEOUT_MS };

function validateName(name: string): void {
	const result = InstanceName.safeParse(name);
	if (!result.success) {
		throw new IncusError("INVALID_NAME", `invalid instance name: ${name}`);
	}
}

function enc(name: string): string {
	return encodeURIComponent(name);
}

export class IncusWorkspaceProvider implements WorkspaceProvider {
	private readonly client: IncusClient;
	private readonly pool: string;
	private readonly profile: string;
	private readonly imageAlias: string;
	private readonly agentPort: number;
	private readonly log: Logger;
	private readonly cgroupRoot: string;
	private readonly procRoot: string;
	private readonly hostCpuCount: number;
	private readonly thinPoolStatusPath: string | undefined;
	private readonly ghcrCaPath: string;
	private readonly cacheOffPath: string;
	private readonly agentInstructionsPath: string;
	private readonly claudeManagedSettingsPath: string;

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
	}) {
		this.agentInstructionsPath =
			opts.agentInstructionsPath ?? AGENT_INSTRUCTIONS_HOST_PATH;
		this.claudeManagedSettingsPath =
			opts.claudeManagedSettingsPath ?? CLAUDE_MANAGED_SETTINGS_HOST_PATH;
		this.ghcrCaPath = opts.ghcrCaPath ?? GHCR_CA_HOST_PATH;
		this.cacheOffPath = opts.cacheOffPath ?? CACHE_OFF_HOST_PATH;
		this.client = opts.client;
		this.pool = opts.pool;
		this.profile = opts.profile;
		this.imageAlias = opts.imageAlias;
		this.agentPort = opts.agentPort;
		this.log = opts.logger ?? silentLogger();
		this.cgroupRoot = opts.cgroupRoot ?? "/sys/fs/cgroup";
		this.procRoot = opts.procRoot ?? "/proc";
		this.hostCpuCount = opts.hostCpuCount ?? availableParallelism();
		this.thinPoolStatusPath = opts.thinPoolStatusPath;
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
				this.client,
				this.pool,
				new Date(),
				this.thinPoolStatusPath,
				signal,
			);
			let fill = poolFillPercent(use);
			// A seeded Docker volume will fill the pool by up to the seed's size.
			if (fill < POOL_FULL_PERCENT) {
				const seedBytes = await this.seedBytesFor(name, signal);
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
			this.client,
			this.pool,
			`${name}-home`,
			sizes.homeGiB,
			{},
			signal,
		);
		await this.ensureDockerVolume(name, sizes.dockerGiB, signal);
		await ensureVolume(
			this.client,
			this.pool,
			`${name}-recovery`,
			sizes.recoveryGiB,
			{},
			signal,
		);

		const imageFingerprint = await this.imageFingerprint(signal);
		const quota = { homeGiB: sizes.homeGiB, dockerGiB: sizes.dockerGiB };

		try {
			await this.client.request(
				"POST",
				"/1.0/instances",
				{
					name,
					source: { type: "image", alias: this.imageAlias },
					profiles: [this.profile],
					devices: {
						home: this.homeDevice(name),
						docker: this.dockerDevice(name),
						recovery: this.recoveryDevice(name),
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
			await this.client.request(
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
			const alias = (await this.client.request(
				"GET",
				`/1.0/images/aliases/${enc(this.imageAlias)}`,
				undefined,
				signal,
			)) as { target: string };
			return alias.target;
		} catch (err) {
			if (err instanceof IncusError && err.code === "NOT_FOUND") {
				throw new IncusError(
					"IMAGE_NOT_FOUND",
					`image alias ${this.imageAlias} not found`,
				);
			}
			throw err;
		}
	}

	private homeDevice(name: string): Record<string, string> {
		return {
			type: "disk",
			pool: this.pool,
			source: `${name}-home`,
			path: "/home/student",
		};
	}

	private dockerDevice(name: string): Record<string, string> {
		return {
			type: "disk",
			pool: this.pool,
			source: `${name}-docker`,
			path: "/var/lib/docker",
		};
	}

	private recoveryDevice(name: string): Record<string, string> {
		return {
			type: "disk",
			pool: this.pool,
			source: `${name}-recovery`,
			path: RECOVERY_PATH,
		};
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
		validateName(name);
		if (!HOSTNAME_PATTERN.test(opts.hostname) || opts.hostname.length > 40) {
			throw new IncusError("INVALID_NAME", `invalid hostname: ${opts.hostname}`);
		}
		if (
			!DNS_NAME_PATTERN.test(opts.previewHostSuffix) ||
			opts.previewHostSuffix.length > 253
		) {
			throw new IncusError(
				"INVALID_NAME",
				`invalid preview host suffix: ${opts.previewHostSuffix}`,
			);
		}
		// The zone name ends up in a path in a command inside the container, so
		// it has to be one of the names this build knows.
		if (!isSystemTimezone(opts.timezone)) {
			throw new IncusError("INVALID_NAME", `invalid timezone: ${opts.timezone}`);
		}

		// The start keeps its own limit; the caller's deadline is added on top (ADR 0034).
		const own = AbortSignal.timeout(opts.timeoutSeconds * 1000);
		const signal = withCaller(caller, opts.timeoutSeconds * 1000);

		// A retry after a start that failed late finds the container running.
		// Every write below deletes then pushes, which is only safe while no
		// student process can put a named pipe back in between (SPEC.md §24).
		if ((await this.instanceStatus(name, signal)) === "Running") {
			await this.client.request(
				"PUT",
				`/1.0/instances/${enc(name)}/state`,
				{ action: "stop", force: true },
				signal,
				opts.timeoutSeconds,
			);
			this.log.info({ instance: name }, "running instance stopped before a start");
		}

		if (opts.dockerGiB !== undefined) {
			await this.ensureDockerDevice(name, opts.dockerGiB, signal);
		}

		// Written before the start, so dockerd reads it; never fatal.
		const docker = opts.docker;
		let ghcr: boolean | null = null;
		if (docker !== undefined) {
			ghcr =
				(await this.optionalStep(
					name,
					signal,
					"could not write the Docker registry settings; starting without them",
					() =>
						writeDockerConfig(
							this.client,
							name,
							docker,
							{
								caPath: this.ghcrCaPath,
								cacheOffPath: this.cacheOffPath,
								log: this.log,
							},
							signal,
						),
				)) ?? null;
		}

		// Rewritten at every start, so an edit or deletion lasts one session.
		const written = await this.optionalStep(
			name,
			signal,
			"could not write the coding-agent instructions; starting without them",
			() =>
				writeAgentInstructions(this.client, name, this.agentInstructionsPath, signal),
		);
		if (written === false) {
			this.log.warn(
				{ instance: name, path: this.agentInstructionsPath },
				"the coding-agent instructions template is missing; starting without them",
			);
		}

		// Rewritten at every start, so a deleted /etc/claude-code gets its settings back.
		const settingsWritten = await this.optionalStep(
			name,
			signal,
			"could not write Claude Code's managed settings; starting without them",
			() =>
				writeClaudeManagedSettings(
					this.client,
					name,
					this.claudeManagedSettingsPath,
					signal,
				),
		);
		if (settingsWritten === false) {
			this.log.warn(
				{ instance: name, path: this.claudeManagedSettingsPath },
				"Claude Code's managed settings template is missing; starting without them",
			);
		}

		await writeStartFiles(
			this.client,
			name,
			{
				hostname: opts.hostname,
				timezone: opts.timezone,
				previewHostSuffix: opts.previewHostSuffix,
				agentToken: opts.agentToken,
			},
			signal,
		);

		const recoveryAttached =
			opts.recoveryGiB !== undefined &&
			(await this.ensureRecoveryDevice(name, opts.recoveryGiB, signal));

		// A throttle ends at a stop unless the worker says it is held; a held
		// one is set before the instance runs, so it never runs at full speed.
		if (
			opts.cpuAllowance !== undefined &&
			!CpuAllowance.safeParse(opts.cpuAllowance).success
		) {
			throw new IncusError(
				"BAD_REQUEST",
				`invalid cpu allowance: ${opts.cpuAllowance}`,
			);
		}
		const status = await this.writeCpuAllowance(
			name,
			opts.cpuAllowance ?? null,
			signal,
		);

		// Once the start request is sent, Incus starts the instance whatever the
		// caller does, so the setup below runs to the end on its own limits: the
		// worker's sweep would mark a half-set-up workspace running (ADR 0034).
		signal.throwIfAborted();
		try {
			// Something may have started it since the check above.
			if (status !== "Running") {
				try {
					await this.client.request(
						"PUT",
						`/1.0/instances/${enc(name)}/state`,
						{ action: "start" },
						own,
						opts.timeoutSeconds,
					);
				} catch (err) {
					if ((await this.instanceStatus(name, own).catch(() => null)) !== "Running") {
						throw err;
					}
				}
			}

			const deadline = Date.now() + opts.timeoutSeconds * 1000;
			const ipv4 = await waitForAddress(this.client, name, deadline, own);

			await setHostname(
				this.client,
				this.log,
				name,
				opts.hostname,
				opts.timeoutSeconds,
				own,
			);

			await setTimezone(this.client, name, opts.timezone, opts.timeoutSeconds, own);

			// After the start: a first start after create or copy runs the image's
			// /etc/hosts template, which would drop the line.
			if (ghcr !== null) {
				await this.optionalStep(
					name,
					own,
					"could not write the ghcr.io hosts line",
					() => writeGhcrHosts(this.client, name, ghcr, own),
				);
			}

			if (recoveryAttached) {
				await prepareRecoveryMount(
					this.client,
					this.log,
					name,
					opts.timeoutSeconds,
					own,
				);
			}

			// The agent wait has its own 15 s, not the start's timeout.
			await waitForAgent(this.log, ipv4, this.agentPort, opts.agentToken);
			if (caller?.aborted) {
				this.log.info({ instance: name }, "start finished after the caller left");
			}

			return { ipv4 };
		} catch (err) {
			// A half-set-up instance must not stay running for the sweep to mark it running.
			await this.forceStopAfterFailedStart(name, opts.timeoutSeconds);
			throw err;
		}
	}

	private async forceStopAfterFailedStart(
		name: string,
		timeoutSeconds: number,
	): Promise<void> {
		try {
			await this.client.request(
				"PUT",
				`/1.0/instances/${enc(name)}/state`,
				{ action: "stop", force: true },
				AbortSignal.timeout(timeoutSeconds * 1000),
				timeoutSeconds,
			);
			this.log.info({ instance: name }, "instance stopped after a failed start");
		} catch (err) {
			this.log.warn(
				{ instance: name, err: errorMessage(err) },
				"could not stop the instance after a failed start",
			);
		}
	}

	/**
	 * Run a start step whose failure only costs a feature: warn and go on.
	 * An abort is not such a failure, so it ends the start (ADR 0034).
	 */
	private async optionalStep<T>(
		name: string,
		signal: AbortSignal,
		message: string,
		step: () => Promise<T>,
	): Promise<T | undefined> {
		try {
			return await step();
		} catch (err) {
			if (signal.aborted) throw err;
			this.log.warn({ instance: name, err: errorMessage(err) }, message);
			return undefined;
		}
	}

	/**
	 * Put back a Docker volume that a failed Reset Docker left off (ADR 0021).
	 * Unlike recovery this is fatal: Docker without its volume would fill the
	 * root filesystem. The only volume it creates is `<name>-docker`.
	 */
	private async ensureDockerDevice(
		name: string,
		sizeGiB: number,
		signal: AbortSignal,
	): Promise<void> {
		const inst = (await this.client.request(
			"GET",
			`/1.0/instances/${enc(name)}`,
			undefined,
			signal,
		)) as InstanceConfig;
		if (inst.devices?.docker) {
			return;
		}
		await this.ensureDockerVolume(name, sizeGiB, signal);
		// PATCH merges devices, so it adds this one and cannot drop another.
		await this.client.request(
			"PATCH",
			`/1.0/instances/${enc(name)}`,
			{ devices: { docker: this.dockerDevice(name) } },
			signal,
		);
		this.log.info({ instance: name }, "docker volume re-attached");
	}

	/**
	 * Give a workspace made before recovery volumes existed its recovery volume (ADR 0020).
	 * Never fatal, so a new feature cannot lock a student out, and the only
	 * volume it creates is `<name>-recovery`. Returns whether the device is on.
	 */
	private async ensureRecoveryDevice(
		name: string,
		sizeGiB: number,
		signal: AbortSignal,
	): Promise<boolean> {
		try {
			const inst = (await this.client.request(
				"GET",
				`/1.0/instances/${enc(name)}`,
				undefined,
				signal,
			)) as InstanceConfig;
			if (inst.devices?.recovery) {
				return true;
			}
			await ensureVolume(
				this.client,
				this.pool,
				`${name}-recovery`,
				sizeGiB,
				{},
				signal,
			);
			// PATCH merges devices, so it adds this one and cannot drop another.
			await this.client.request(
				"PATCH",
				`/1.0/instances/${enc(name)}`,
				{ devices: { recovery: this.recoveryDevice(name) } },
				signal,
			);
			this.log.info({ instance: name }, "recovery volume attached");
			return true;
		} catch (err) {
			if (signal.aborted) throw err;
			this.log.warn(
				{ instance: name, err: errorMessage(err) },
				"could not attach the recovery volume; starting without it",
			);
			return false;
		}
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
		const current = await this.instanceStatus(name, caller).catch((err: unknown) => {
			if (err instanceof IncusError && err.code === "NOT_FOUND") throw err;
			if (caller?.aborted) throw err;
			return undefined;
		});
		if (current === "Stopped") {
			return { forced: false };
		}

		// Once the graceful stop is sent, it runs through to the forced stop whatever the caller does:
		// a half-done stop would leave a SIGTERM-ignoring workspace running (ADR 0034).
		caller?.throwIfAborted();
		const ownLimit = (opts.timeoutSeconds + 5) * 1000;
		try {
			await this.client.request(
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
				await this.client.request(
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
			this.log.info({ instance: name }, "stop finished after the caller left");
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
			if ((await this.instanceStatus(name, signal).catch(() => null)) === "Stopped") {
				return true;
			}
			if (Date.now() >= deadline) {
				return false;
			}
			await sleep(250, undefined, { signal });
		}
	}

	private async instanceStatus(
		name: string,
		signal?: AbortSignal,
	): Promise<string | undefined> {
		const state = (await this.client.request(
			"GET",
			`/1.0/instances/${enc(name)}/state`,
			undefined,
			signal,
		)) as { status?: string } | undefined;
		return state?.status;
	}

	async list(): Promise<InstanceStatus[]> {
		const instances = (await this.client.request(
			"GET",
			"/1.0/instances?recursion=2",
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
		return this.client.ping();
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
		const { metadata, etag } = await this.client.getWithEtag(path, signal);
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
			if (docker.source !== dockerVolume || docker.pool !== this.pool) {
				throw new IncusError(
					"OPERATION_FAILED",
					`instance ${name} has an unexpected docker device; refusing to reset Docker`,
				);
			}
			// PATCH cannot remove a device (Incus merges the map), so write the
			// rest back exactly as read, guarded by the ETag.
			const { docker: _removed, ...devices } = inst.devices;
			await this.client.putIfMatch(
				path,
				{ ...writableFields(inst), devices },
				etag,
				signal,
			);
		}

		try {
			await this.client.request(
				"DELETE",
				volumePath(this.pool, dockerVolume),
				undefined,
				signal,
			);
		} catch (err) {
			if (!(err instanceof IncusError && err.code === "NOT_FOUND")) {
				throw err;
			}
		}

		await this.ensureDockerVolume(name, opts.dockerGiB, signal);

		await this.client.request(
			"PATCH",
			path,
			{ devices: { docker: this.dockerDevice(name) } },
			signal,
		);
		this.log.info({ instance: name }, "docker volume replaced");
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
		const inst = (await this.client.request(
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

		await this.client.request(
			"POST",
			`/1.0/instances/${enc(name)}/rebuild`,
			{ source: { type: "image", alias: this.imageAlias } },
			signal,
			REBUILD_TIMEOUT_SECONDS,
		);
		this.log.info({ instance: name, imageFingerprint }, "instance rebuilt");

		return { imageFingerprint };
	}

	async setCpuAllowance(
		name: string,
		allowance: string | null,
		signal?: AbortSignal,
	): Promise<void> {
		validateName(name);
		// Checked again here: a percentage is only a soft share (ADR 0032).
		if (allowance !== null && !CpuAllowance.safeParse(allowance).success) {
			throw new IncusError("BAD_REQUEST", `invalid cpu allowance: ${allowance}`);
		}
		await this.writeCpuAllowance(name, allowance, signal);
		this.log.info({ instance: name, allowance }, "cpu allowance set");
	}

	/**
	 * PATCH cannot remove a config key, so write the instance back as read,
	 * with only the allowance changed, guarded by the ETag.
	 */
	private async writeCpuAllowance(
		name: string,
		allowance: string | null,
		signal?: AbortSignal,
	): Promise<string | undefined> {
		const path = `/1.0/instances/${enc(name)}`;
		const { metadata, etag } = await this.client.getWithEtag(path, signal);
		const inst = metadata as InstanceConfig;
		const { [CPU_ALLOWANCE_KEY]: current, ...config } = inst.config ?? {};
		if ((current ?? null) === allowance) {
			return inst.status;
		}
		if (allowance !== null) {
			config[CPU_ALLOWANCE_KEY] = allowance;
		}
		await this.client.putIfMatch(
			path,
			{ ...writableFields(inst), config },
			etag,
			signal,
		);
		return inst.status;
	}

	/**
	 * One Incus listing for the resource guard (ADR 0032). Totals only: no
	 * process, command line or file name is read (SPEC.md 20.1).
	 */
	async usage(): Promise<InstanceUsage[]> {
		const instances = (await this.client.request(
			"GET",
			"/1.0/instances?recursion=2",
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
				this.log.warn({ instance: inst.name }, "no memory limit; usage skipped");
				continue;
			}
			result.push({
				name: inst.name,
				cpuUsageNs: Math.max(0, Math.trunc(inst.state?.cpu?.usage ?? 0)),
				bootMarker:
					(inst.state?.pid ?? 0) > 0 ? Math.trunc(inst.state?.pid ?? 0) : null,
				cpuLimit: countIncusCpus(expanded["limits.cpu"]) ?? this.hostCpuCount,
				memoryBytes: await this.workingSetBytes(
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
	async processes(name: string, signal?: AbortSignal): Promise<InstanceProcess[]> {
		validateName(name);
		const inst = (await this.client.request(
			"GET",
			`/1.0/instances/${enc(name)}`,
			undefined,
			signal,
		)) as { config?: Record<string, string>; expanded_config?: Record<string, string> };
		const state = (await this.client.request(
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
			this.client.project === "default" ? name : `${this.client.project}_${name}`;
		try {
			return await readInstanceProcesses({
				procRoot: this.procRoot,
				cgroupDir: `${this.cgroupRoot}/lxc.payload.${scope}`,
				initPid,
				idmap: parseIdmap(inst.config?.["volatile.idmap.current"]),
				cpuLimit:
					countIncusCpus(inst.expanded_config?.["limits.cpu"]) ?? this.hostCpuCount,
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
	private async workingSetBytes(name: string, usage: number): Promise<number> {
		try {
			const inactive = await readInactiveFileBytes(
				this.client.project,
				name,
				this.cgroupRoot,
			);
			return Math.max(0, Math.trunc(usage - inactive));
		} catch (err) {
			this.log.warn(
				{ instance: name, err: errorMessage(err) },
				"could not read the instance's memory.stat; reporting usage with cache",
			);
			return Math.max(0, Math.trunc(usage));
		}
	}

	/**
	 * Make `<name>-docker` as a thin copy of the seed when one exists, sized
	 * at the Docker size plus the seed's, else empty. A volume
	 * that already exists is kept, never replaced. A copy that fails falls
	 * back to an empty volume, so a broken seed never blocks a workspace.
	 * The copy is only ever attached as this one instance's Docker device.
	 * An abort is not a broken seed, so it never falls back (ADR 0034).
	 */
	private async ensureDockerVolume(
		name: string,
		dockerGiB: number,
		signal?: AbortSignal,
	): Promise<void> {
		const volume = `${name}-docker`;
		let seed: SeedInfo | null = null;
		try {
			seed = await this.seedInfo(signal);
		} catch (err) {
			if (signal?.aborted) throw err;
			this.log.warn(
				{ instance: name, err: errorMessage(err) },
				"could not read the Docker seed; making an empty Docker volume",
			);
		}
		if (seed) {
			try {
				// A copy cannot be smaller than its source, which is the build volume's size.
				const source = (await this.client.request(
					"GET",
					volumePath(this.pool, SEED_VOLUME_NAME),
					undefined,
					signal,
				)) as { config?: Record<string, unknown> };
				const sourceGiB = Math.ceil(
					(parseIncusSize(source.config?.size) ?? 0) / 2 ** 30,
				);
				const totalGiB = Math.max(
					dockerGiB + Math.ceil(seed.sizeBytes / 1024 ** 3),
					sourceGiB,
				);
				await this.client.request(
					"POST",
					`/1.0/storage-pools/${enc(this.pool)}/volumes/custom`,
					{
						name: volume,
						config: {
							size: `${totalGiB}GiB`,
							"security.shifted": "true",
							[SEED_SHARE_KEY]: String(totalGiB - dockerGiB),
						},
						source: { type: "copy", pool: this.pool, name: SEED_VOLUME_NAME },
					},
					signal,
					undefined,
					VOLUME_CREATE_TIMEOUT_MS,
				);
				return;
			} catch (err) {
				if (err instanceof IncusError && err.code === "ALREADY_EXISTS") return;
				if (signal?.aborted) throw err;
				this.log.warn(
					{ instance: name, err: errorMessage(err) },
					"could not copy the Docker seed; making an empty Docker volume",
				);
				// A half-made copy would otherwise be adopted below.
				await this.client
					.request("DELETE", volumePath(this.pool, volume))
					.catch(() => {});
			}
		}
		await ensureVolume(this.client, this.pool, volume, dockerGiB, {}, signal);
	}

	/**
	 * The seed's size when `name`'s Docker volume will be copied from it, else
	 * 0. An unreadable seed counts as 0, as ensureDockerVolume then makes an
	 * empty volume.
	 */
	private async seedBytesFor(name: string, signal?: AbortSignal): Promise<number> {
		try {
			const seed = await this.seedInfo(signal);
			if (
				!seed ||
				(await volumeExists(this.client, this.pool, `${name}-docker`, signal))
			)
				return 0;
			return seed.sizeBytes;
		} catch (err) {
			if (signal?.aborted) throw err;
			return 0;
		}
	}

	async seedInfo(signal?: AbortSignal): Promise<SeedInfo | null> {
		let volume: { config?: Record<string, string> };
		try {
			volume = (await this.client.request(
				"GET",
				volumePath(this.pool, SEED_VOLUME_NAME),
				undefined,
				signal,
			)) as { config?: Record<string, string> };
		} catch (err) {
			if (err instanceof IncusError && err.code === "NOT_FOUND") return null;
			throw err;
		}
		const raw = volume?.config?.[SEED_INFO_KEY];
		if (!raw) return null;
		try {
			const parsed = SeedInfo.safeParse(JSON.parse(raw));
			return parsed.success ? parsed.data : null;
		} catch {
			return null;
		}
	}

	async hostSnapshot(): Promise<HostSnapshot> {
		return readHostSnapshot(this.client, {
			pool: this.pool,
			profile: this.profile,
			imageAlias: this.imageAlias,
			thinPoolStatusPath: this.thinPoolStatusPath,
		});
	}

	async growVolumes(
		name: string,
		sizes: GrowVolumesRequest,
		signal?: AbortSignal,
	): Promise<GrowVolumesResponse> {
		validateName(name);
		return growVolumes(this.client, this.pool, name, sizes, signal);
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
		validateName(name);
		if (limits.cpu !== null && limits.cpu > this.hostCpuCount) {
			throw new IncusError(
				"BAD_REQUEST",
				`the host has ${this.hostCpuCount} CPUs; ${limits.cpu} is more`,
			);
		}
		const wanted: Record<string, string | null> = {
			"limits.cpu": limits.cpu === null ? null : String(limits.cpu),
			"limits.memory": limits.memoryMiB === null ? null : `${limits.memoryMiB}MiB`,
			"limits.processes": limits.processes === null ? null : String(limits.processes),
		};
		const path = `/1.0/instances/${enc(name)}`;
		const { metadata, etag } = await this.client.getWithEtag(path, signal);
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
		await this.client.putIfMatch(
			path,
			{ ...writableFields(inst), config },
			etag,
			signal,
		);
		this.log.info({ instance: name, ...limits }, "instance limits set");
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
		validateName(name);
		const read = await this.client.exec(
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

	async keptVolumes(): Promise<KeptVolumesResponse> {
		const volumes = (await this.client.request(
			"GET",
			`/1.0/storage-pools/${enc(this.pool)}/volumes/custom?recursion=1`,
		)) as Array<{ name: string; created_at?: string }>;
		const result: KeptVolumesResponse = { snapshots: [], keptHomes: [] };
		for (const volume of volumes) {
			if (KeptHomeVolumeName.safeParse(volume.name).success) {
				result.keptHomes.push({
					volume: volume.name,
					instance: volume.name.slice(0, "ws-".length + 24),
					createdAt: volume.created_at ?? "",
				});
				continue;
			}
			if (!WorkspaceVolumeName.safeParse(volume.name).success) continue;
			const snapshots = (await this.client.request(
				"GET",
				`${volumePath(this.pool, volume.name)}/snapshots?recursion=1`,
			)) as Array<{ name: string; created_at?: string }>;
			for (const snapshot of snapshots) {
				// Incus may name a snapshot `<volume>/<snapshot>`.
				const name = snapshot.name.slice(snapshot.name.lastIndexOf("/") + 1);
				if (!PreChangeSnapshotName.safeParse(name).success) continue;
				result.snapshots.push({
					volume: volume.name,
					name,
					createdAt: snapshot.created_at ?? "",
				});
			}
		}
		return result;
	}

	async deleteSnapshot(volume: string, snapshot: string): Promise<void> {
		// Checked again here: the backup's own snapshot must never be deleted.
		if (
			!WorkspaceVolumeName.safeParse(volume).success ||
			!PreChangeSnapshotName.safeParse(snapshot).success
		) {
			throw new IncusError("BAD_REQUEST", "only pre-change snapshots can be deleted");
		}
		await this.client.request(
			"DELETE",
			`${volumePath(this.pool, volume)}/snapshots/${enc(snapshot)}`,
		);
		this.log.info({ volume, snapshot }, "snapshot deleted");
	}

	async deleteKeptHome(volume: string, signal?: AbortSignal): Promise<void> {
		if (!KeptHomeVolumeName.safeParse(volume).success) {
			throw new IncusError("BAD_REQUEST", "only kept homes can be deleted");
		}
		const info = (await this.client.request(
			"GET",
			volumePath(this.pool, volume),
			undefined,
			signal,
		)) as {
			used_by?: string[];
		};
		if ((info.used_by ?? []).length > 0) {
			throw new VolumeInUseError(volume);
		}
		await this.client.request(
			"DELETE",
			volumePath(this.pool, volume),
			undefined,
			signal,
		);
		this.log.info({ volume }, "kept home deleted");
	}

	/**
	 * Swap an imported home in the way Reset Docker swaps Docker's: detach
	 * home, keep the old volume under a new name, rename the import, attach.
	 * Each step can be repeated, so a retry finishes a half-done swap.
	 */
	async replaceHome(name: string, signal?: AbortSignal): Promise<ReplaceHomeResponse> {
		validateName(name);
		const path = `/1.0/instances/${enc(name)}`;
		const homeVolume = `${name}-home`;
		const importVolume = `${name}-home-import`;
		const { metadata, etag } = await this.client.getWithEtag(path, signal);
		const inst = metadata as InstanceConfig;
		assertStopped(name, inst.status);

		const home = inst.devices?.home;
		if (home && (home.source !== homeVolume || home.pool !== this.pool)) {
			throw new IncusError(
				"OPERATION_FAILED",
				`instance ${name} has an unexpected home device; refusing to replace it`,
			);
		}
		const importExists = await volumeExists(
			this.client,
			this.pool,
			importVolume,
			signal,
		);
		if (home && !importExists) {
			throw new IncusError("NOT_FOUND", `volume ${importVolume} not found`);
		}

		if (home) {
			const { home: _removed, ...devices } = inst.devices;
			await this.client.putIfMatch(
				path,
				{ ...writableFields(inst), devices },
				etag,
				signal,
			);
		}

		if (
			importExists &&
			(await volumeExists(this.client, this.pool, homeVolume, signal))
		) {
			const keptName = `${name}-home-replaced-${Math.floor(Date.now() / 1000)}`;
			await this.client.request(
				"POST",
				volumePath(this.pool, homeVolume),
				{ name: keptName },
				signal,
			);
		}
		if (importExists) {
			await this.client.request(
				"POST",
				volumePath(this.pool, importVolume),
				{ name: homeVolume },
				signal,
			);
		}

		await this.client.request(
			"PATCH",
			path,
			{ devices: { home: this.homeDevice(name) } },
			signal,
		);

		const kept = await this.newestKeptHome(name, signal);
		if (!kept) {
			throw new IncusError("OPERATION_FAILED", `no kept home for ${name}`);
		}
		this.log.info({ instance: name, kept }, "home replaced");
		return { kept };
	}

	private async newestKeptHome(
		name: string,
		signal?: AbortSignal,
	): Promise<string | null> {
		const volumes = (await this.client.request(
			"GET",
			`/1.0/storage-pools/${enc(this.pool)}/volumes/custom?recursion=1`,
			undefined,
			signal,
		)) as Array<{ name: string }>;
		const prefix = `${name}-home-replaced-`;
		let newest: { name: string; at: number } | null = null;
		for (const { name: volume } of volumes) {
			if (!volume.startsWith(prefix)) continue;
			const at = Number(volume.slice(prefix.length));
			if (Number.isInteger(at) && (!newest || at > newest.at)) {
				newest = { name: volume, at };
			}
		}
		return newest?.name ?? null;
	}

	/**
	 * Each running instance with its image serial and when its agent started,
	 * both read on the host.
	 */
	async runningAgents(): Promise<RunningAgent[]> {
		const instances = (await this.client.request(
			"GET",
			"/1.0/instances?recursion=1",
		)) as Array<{ name: string; status: string; config?: Record<string, string> }>;
		const agents: RunningAgent[] = [];
		for (const inst of instances) {
			if (inst.status !== "Running") continue;
			const scope =
				this.client.project === "default"
					? inst.name
					: `${this.client.project}_${inst.name}`;
			agents.push({
				name: inst.name,
				imageSerial: inst.config?.["image.serial"] ?? null,
				startedAt: await readUnitStartTime(
					this.procRoot,
					`${this.cgroupRoot}/lxc.payload.${scope}/system.slice/portikus-workspace-agent.service`,
				),
			});
		}
		return agents;
	}

	/** Restart the agent unit inside a running instance. */
	async restartAgent(name: string): Promise<void> {
		validateName(name);
		const { status } = await this.client.exec(
			name,
			["systemctl", "restart", "portikus-workspace-agent.service"],
			{ timeoutSeconds: AGENT_RESTART_TIMEOUT_SECONDS },
		);
		if (status !== null && status !== 0) {
			throw new IncusError("OPERATION_FAILED", `systemctl restart exited ${status}`);
		}
	}
}
