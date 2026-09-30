import { availableParallelism } from "node:os";
import {
	type AddedPackagesResponse,
	CpuAllowance,
	type CreateInstanceResponse,
	countIncusCpus,
	type GrowVolumesRequest,
	type GrowVolumesResponse,
	type HostSnapshot,
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
	type WorkspaceDockerConfig,
	WorkspaceVolumeName,
} from "@portikus/contracts";
import { type Logger, silentLogger } from "@portikus/observability";
import type { RunningAgent } from "./agent-restart.js";
import {
	CACHE_OFF_HOST_PATH,
	GHCR_CA_HOST_PATH,
	writeDockerConfig,
	writeGhcrHosts,
} from "./docker-config.js";
import type { SeedBuildHost } from "./docker-seed.js";
import {
	growVolumes,
	parseIncusSize,
	readCurrentImage,
	readHostSnapshot,
	readInactiveFileBytes,
	readPoolUse,
	SEED_SHARE_KEY,
} from "./host.js";
import { type IncusClient, IncusError } from "./incus.js";
import { parseIdmap, readInstanceProcesses, readUnitStartTime } from "./processes.js";

export interface WorkspaceProvider extends SeedBuildHost {
	/** The current Docker seed, or null when none is built (issue #840). */
	seedInfo(): Promise<SeedInfo | null>;
	create(
		name: string,
		sizes: { homeGiB: number; dockerGiB: number; recoveryGiB: number },
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
	): Promise<StartInstanceResponse>;
	stop(name: string, opts: { timeoutSeconds: number }): Promise<StopInstanceResponse>;
	list(): Promise<InstanceStatus[]>;
	healthy(): Promise<boolean>;
	/** Replace the Docker volume with a clean one; the instance must be stopped. */
	resetDocker(name: string, opts: { dockerGiB: number }): Promise<void>;
	/** Replace the root filesystem from the current image; the instance must be stopped. */
	rebuild(
		name: string,
		opts: { resetDocker: boolean; dockerGiB: number },
	): Promise<RebuildInstanceResponse>;
	/** One read-only look at the host for the admin Health tab (SPEC.md §25.6). */
	hostSnapshot(): Promise<HostSnapshot>;
	/** Grow the home and Docker volumes; a smaller size is refused (SPEC.md §20.1). */
	growVolumes(name: string, sizes: GrowVolumesRequest): Promise<GrowVolumesResponse>;
	/** CPU time and memory of every running instance, from Incus (ADR 0032). */
	usage(): Promise<InstanceUsage[]>;
	/** Set or, with null, remove `limits.cpu.allowance` (ADR 0032). */
	setCpuAllowance(name: string, allowance: string | null): Promise<void>;
	/** The heaviest processes of a running instance, short names only (ADR 0037). */
	processes(name: string, signal?: AbortSignal): Promise<InstanceProcess[]>;
	/** Set or, with null, remove the instance's own CPU, memory and process limits. */
	setLimits(name: string, limits: SetInstanceLimitsRequest): Promise<void>;
	/** The packages the student added, from the apt hook's list in their home. */
	addedPackages(name: string): Promise<AddedPackagesResponse>;
	/** Pre-change snapshots and homes kept by Replace home. */
	keptVolumes(): Promise<KeptVolumesResponse>;
	/** Delete one `pre-*` snapshot of a workspace volume. */
	deleteSnapshot(volume: string, snapshot: string): Promise<void>;
	/** Delete one kept home that nothing uses. */
	deleteKeptHome(volume: string): Promise<void>;
	/** Swap `<name>-home-import` in as the home and keep the old one; stopped only. */
	replaceHome(name: string): Promise<ReplaceHomeResponse>;
}

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

/** Refused because a volume is still attached to an instance; answered 409. */
export class VolumeInUseError extends IncusError {
	constructor(volume: string) {
		super("OPERATION_FAILED", `volume ${volume} is in use`);
		this.name = "VolumeInUseError";
	}
}

/** Where the image's apt hook writes the packages the student added. */
const ADDED_PACKAGES_PATH = "/home/student/.portikus/apt-packages.txt";

/** The most the controller reads of that file. */
export const ADDED_PACKAGES_MAX_BYTES = 64 * 1024;

/** Where the workspace agent reads its bearer token (ADR 0009). */
const AGENT_TOKEN_PATH = "/etc/portikus/agent.token";

/** A lowercase DNS label; anything else must never reach the container. */
const HOSTNAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/** A lowercase DNS name, checked again here as defence in depth. */
const DNS_NAME_PATTERN =
	/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/**
 * Shell profile read by every login shell in the container, so a terminal,
 * a template, and a coding agent all see where previews are published
 * (issue #263, BROWSER-HANDLING.md section 14). It never holds a secret.
 */
const PROFILE_PATH = "/etc/profile.d/portikus.sh";

/** Where the recovery volume is mounted inside the container (ADR 0020). */
export const RECOVERY_PATH = "/var/lib/portikus/recovery";

/** How long to wait for Incus to replace a root filesystem. */
const REBUILD_TIMEOUT_SECONDS = 600;

/** The seed volume's config key holding its `SeedInfo` as JSON (issue #840). */
export const SEED_INFO_KEY = "user.portikus.seed";
/** The seed builder container and its Docker volume, while a build runs. */
export const SEED_BUILDER = "portikus-seed-builder";
export const SEED_BUILD_VOLUME = "portikus-docker-seed-build";
/** The previous seed during the swap. */
export const SEED_OLD_VOLUME = "portikus-docker-seed-old";
/** How long the builder has to run with dockerd answering. */
const SEED_BUILDER_START_SECONDS = 120;

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

/**
 * A volume create on a busy thin pool can pass the default 30 s, so each gets
 * 60 s. The instance create's wait is 240 s and the worker's whole create
 * budget is 300 s; a retry adopts whatever already exists.
 */
export const VOLUME_CREATE_TIMEOUT_MS = 60_000;

/**
 * How long the agent has to answer /health once the instance is running. This
 * is its own budget, not the rest of the start timeout, so one broken agent
 * cannot hold the worker's serial start loop for the whole start deadline.
 */
export const AGENT_HEALTH_TIMEOUT_MS = 15_000;

/** How long one agent restart after an upgrade may take. */
export const AGENT_RESTART_TIMEOUT_SECONDS = 60;

/** The instance create's operation wait, inside the worker's 300 s create budget. */
export const INSTANCE_CREATE_WAIT_SECONDS = 240;

function validateName(name: string): void {
	const result = InstanceName.safeParse(name);
	if (!result.success) {
		throw new IncusError("INVALID_NAME", `invalid instance name: ${name}`);
	}
}

function enc(name: string): string {
	return encodeURIComponent(name);
}

/**
 * The exit status of a finished exec operation, or null when Incus did not
 * report one. Incus puts it in the operation's own metadata as `return`.
 */
function execExitStatus(result: unknown): number | null {
	const meta = (result as { metadata?: { return?: unknown } } | undefined)?.metadata;
	return typeof meta?.return === "number" ? meta.return : null;
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
	}) {
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
	): Promise<CreateInstanceResponse> {
		validateName(name);

		// Refuse before any volume is made; start, stop, rebuild and adopting an
		// instance that already exists are never refused.
		if (!(await this.instanceExists(name))) {
			const use = await readPoolUse(
				this.client,
				this.pool,
				new Date(),
				this.thinPoolStatusPath,
			);
			const fill = poolFillPercent(use);
			if (fill >= POOL_FULL_PERCENT) {
				throw new IncusError(
					"POOL_FULL",
					`storage pool is ${Math.floor(fill)}% full; new workspaces are refused`,
				);
			}
		}

		await this.ensureVolume(`${name}-home`, sizes.homeGiB);
		await this.ensureDockerVolume(name, sizes.dockerGiB);
		await this.ensureVolume(`${name}-recovery`, sizes.recoveryGiB);

		const imageFingerprint = await this.imageFingerprint();
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
				undefined,
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

	private async instanceExists(name: string): Promise<boolean> {
		try {
			await this.client.request("GET", `/1.0/instances/${enc(name)}`);
			return true;
		} catch (err) {
			if (err instanceof IncusError && err.code === "NOT_FOUND") return false;
			throw err;
		}
	}

	private async imageFingerprint(): Promise<string> {
		try {
			const alias = (await this.client.request(
				"GET",
				`/1.0/images/aliases/${enc(this.imageAlias)}`,
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
		// it has to be one of the names this build knows (issue #287).
		if (!isSystemTimezone(opts.timezone)) {
			throw new IncusError("INVALID_NAME", `invalid timezone: ${opts.timezone}`);
		}

		const signal = AbortSignal.timeout(opts.timeoutSeconds * 1000);

		if (opts.dockerGiB !== undefined) {
			await this.ensureDockerDevice(name, opts.dockerGiB, signal);
		}

		// Written before the start, so dockerd reads it; never fatal (issue #840).
		let ghcr: boolean | null = null;
		if (opts.docker !== undefined) {
			try {
				ghcr = await writeDockerConfig(
					this.client,
					name,
					opts.docker,
					{ caPath: this.ghcrCaPath, cacheOffPath: this.cacheOffPath, log: this.log },
					signal,
				);
			} catch (err) {
				this.log.warn(
					{ instance: name, err: err instanceof Error ? err.message : String(err) },
					"could not write the Docker registry settings; starting without them",
				);
			}
		}

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

		// A retry after a start that failed late finds the container running.
		if (status !== "Running") {
			try {
				await this.client.request(
					"PUT",
					`/1.0/instances/${enc(name)}/state`,
					{ action: "start" },
					signal,
					opts.timeoutSeconds,
				);
			} catch (err) {
				if ((await this.instanceStatus(name, signal).catch(() => null)) !== "Running") {
					throw err;
				}
			}
		}

		const deadline = Date.now() + opts.timeoutSeconds * 1000;
		const ipv4 = await this.waitForAddress(name, deadline, signal);

		await this.setHostname(name, opts.hostname, signal, opts.timeoutSeconds);

		await this.setTimezone(name, opts.timezone, signal, opts.timeoutSeconds);

		// Again after the start: a first start after create or copy runs the
		// image's /etc/hosts template, which drops the line written above.
		if (ghcr !== null) {
			try {
				await writeGhcrHosts(this.client, name, ghcr, signal);
			} catch (err) {
				this.log.warn(
					{ instance: name, err: err instanceof Error ? err.message : String(err) },
					"could not write the ghcr.io hosts line",
				);
			}
		}

		await this.client.pushFile(
			name,
			PROFILE_PATH,
			// TZ is a default, not an override: tmux sets the session's current
			// zone and a login shell sources this file afterwards, so a student
			// who changes their timezone must not get the start-time zone back
			// (issue #287). The zone was validated against the system list.
			`export PORTIKUS_PREVIEW=true\n` +
				`export PORTIKUS_PREVIEW_HOST_SUFFIX=${opts.previewHostSuffix}\n` +
				`export TZ="\${TZ:-${opts.timezone}}"\n`,
			{ uid: 0, gid: 0, mode: "0644" },
			signal,
		);

		await this.client.pushFile(
			name,
			AGENT_TOKEN_PATH,
			opts.agentToken,
			{ uid: 1000, gid: 1000, mode: "0600" },
			signal,
		);

		if (recoveryAttached) {
			await this.prepareRecoveryMount(name, signal, opts.timeoutSeconds);
		}

		await this.waitForAgent(ipv4, opts.agentToken);

		return { ipv4 };
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
		await this.ensureDockerVolume(name, sizeGiB);
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
	 * Give a workspace made before Epic 10 its recovery volume (ADR 0020).
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
			await this.ensureVolume(`${name}-recovery`, sizeGiB);
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
			this.log.warn(
				{ instance: name, err: err instanceof Error ? err.message : String(err) },
				"could not attach the recovery volume; starting without it",
			);
			return false;
		}
	}

	/**
	 * A new volume's root belongs to root, and the agent runs as the student
	 * (ADR 0020). Never fatal. chown and chmod fail when the mount is missing,
	 * where `install -d` would quietly make a directory on the root filesystem.
	 */
	private async prepareRecoveryMount(
		name: string,
		signal: AbortSignal,
		timeoutSeconds: number,
	): Promise<void> {
		for (const command of [
			["chown", "1000:1000", RECOVERY_PATH],
			["chmod", "0700", RECOVERY_PATH],
		]) {
			try {
				const result = await this.client.request(
					"POST",
					`/1.0/instances/${enc(name)}/exec`,
					{
						command,
						"wait-for-websocket": false,
						"record-output": false,
						interactive: false,
					},
					signal,
					timeoutSeconds,
				);
				const status = execExitStatus(result);
				if (status !== null && status !== 0) {
					throw new Error(`${command[0]} exited ${status}`);
				}
			} catch (err) {
				this.log.warn(
					{ instance: name, err: err instanceof Error ? err.message : String(err) },
					"could not prepare the recovery mount",
				);
				return;
			}
		}
	}

	/**
	 * Name the container after the workspace label so the shell prompt reads
	 * `student@<label>` (SPEC.md Epic 8).
	 *
	 * Incus has no instance setting for the hostname, so this writes
	 * `/etc/hostname` for the next boot and runs `hostname` for the current
	 * one. It runs on every start, so an old container picks the label up.
	 */
	private async setHostname(
		name: string,
		hostname: string,
		signal: AbortSignal,
		timeoutSeconds: number,
	): Promise<void> {
		await this.client.pushFile(
			name,
			"/etc/hostname",
			`${hostname}\n`,
			{ uid: 0, gid: 0, mode: "0644" },
			signal,
		);

		await this.client.request(
			"POST",
			`/1.0/instances/${enc(name)}/exec`,
			{
				command: ["hostname", hostname],
				"wait-for-websocket": false,
				"record-output": false,
				interactive: false,
			},
			signal,
			timeoutSeconds,
		);
	}

	/**
	 * Run the container in the owner's timezone (issue #287), so timestamps in
	 * a shell, in logs, and on Git commits match the clock on the wall.
	 *
	 * `/etc/timezone` is what the Debian tools read and `/etc/localtime` is
	 * what the C library reads, so both are set. The zone name was checked
	 * against the known list before this point, so it is safe in a command.
	 * This runs on every start, so a change takes effect at the next start.
	 */
	private async setTimezone(
		name: string,
		timezone: string,
		signal: AbortSignal,
		timeoutSeconds: number,
	): Promise<void> {
		await this.client.pushFile(
			name,
			"/etc/timezone",
			`${timezone}\n`,
			{ uid: 0, gid: 0, mode: "0644" },
			signal,
		);

		const result = await this.client.request(
			"POST",
			`/1.0/instances/${enc(name)}/exec`,
			{
				command: ["ln", "-sfn", `/usr/share/zoneinfo/${timezone}`, "/etc/localtime"],
				"wait-for-websocket": false,
				"record-output": false,
				interactive: false,
			},
			signal,
			timeoutSeconds,
		);

		// A missing zone file in the image makes `ln` fail, and the container
		// would then run in the wrong zone with nothing said (issue #287).
		const status = execExitStatus(result);
		if (status !== null && status !== 0) {
			throw new IncusError(
				"OPERATION_FAILED",
				`could not set the timezone to ${timezone}: ` +
					`/usr/share/zoneinfo/${timezone} is missing from the image ` +
					`(ln exited ${status})`,
			);
		}
	}

	private async waitForAddress(
		name: string,
		deadline: number,
		signal: AbortSignal,
	): Promise<string> {
		while (Date.now() < deadline) {
			const state = (await this.client.request(
				"GET",
				`/1.0/instances/${enc(name)}/state`,
				undefined,
				signal,
			)) as {
				status: string;
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

			if (state.status === "Running" && state.network?.eth0) {
				const addr = state.network.eth0.addresses?.find(
					(a) => a.family === "inet" && a.scope === "global",
				);
				if (addr) {
					return addr.address;
				}
			}

			await new Promise((r) => setTimeout(r, 500));
		}

		throw new IncusError(
			"TIMEOUT",
			`instance ${name} did not reach Running with IPv4 before the start deadline`,
		);
	}

	/** Poll the workspace agent's /health until it answers 200 (SPEC.md 6.3). */
	private async waitForAgent(ipv4: string, agentToken: string): Promise<void> {
		const url = `http://${ipv4}:${this.agentPort}/health`;
		const deadline = Date.now() + AGENT_HEALTH_TIMEOUT_MS;
		let attempt = 0;
		while (Date.now() < deadline) {
			attempt += 1;
			this.log.debug({ ipv4, attempt }, "polling the workspace agent");
			try {
				const res = await fetch(url, {
					headers: { Authorization: `Bearer ${agentToken}` },
					signal: AbortSignal.timeout(2000),
				});
				// Read the body so the connection is released either way.
				await res.arrayBuffer().catch(() => undefined);
				if (res.status === 200) {
					return;
				}
			} catch {
				// Agent not listening yet; retry until the deadline.
			}
			await new Promise((r) => setTimeout(r, 1000));
		}

		throw new IncusError(
			"TIMEOUT",
			`workspace agent at ${ipv4} did not become healthy within ${AGENT_HEALTH_TIMEOUT_MS}ms`,
		);
	}

	async stop(
		name: string,
		opts: { timeoutSeconds: number },
	): Promise<StopInstanceResponse> {
		validateName(name);

		// Stopping an already-stopped instance is a no-op, not a failure.
		// Mid-shutdown this read can fail with "Invalid PID -1" (issue #704);
		// the stop below then settles on the real state.
		const current = await this.instanceStatus(name).catch((err: unknown) => {
			if (err instanceof IncusError && err.code === "NOT_FOUND") throw err;
			return undefined;
		});
		if (current === "Stopped") {
			return { forced: false };
		}

		try {
			await this.client.request(
				"PUT",
				`/1.0/instances/${enc(name)}/state`,
				{
					action: "stop",
					timeout: opts.timeoutSeconds,
					force: false,
				},
				AbortSignal.timeout((opts.timeoutSeconds + 5) * 1000),
				opts.timeoutSeconds,
			);
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
					AbortSignal.timeout((opts.timeoutSeconds + 5) * 1000),
					opts.timeoutSeconds,
				);
			} catch (err) {
				// The instance may already be stopping (Incus then fails with
				// "Invalid PID -1"), so trust the state, not the error (issue #704).
				if (!(await this.settlesStopped(name, opts.timeoutSeconds))) {
					throw err;
				}
			}
			return { forced: true };
		}
	}

	/** Polls the state for up to `timeoutSeconds` (at most 10) and reports whether it reached Stopped. */
	private async settlesStopped(name: string, timeoutSeconds: number): Promise<boolean> {
		const deadline = Date.now() + Math.min(timeoutSeconds, 10) * 1000;
		for (;;) {
			if ((await this.instanceStatus(name).catch(() => null)) === "Stopped") {
				return true;
			}
			if (Date.now() >= deadline) {
				return false;
			}
			await new Promise((r) => setTimeout(r, 250));
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
	async resetDocker(name: string, opts: { dockerGiB: number }): Promise<void> {
		validateName(name);
		const path = `/1.0/instances/${enc(name)}`;
		const dockerVolume = `${name}-docker`;
		const { metadata, etag } = await this.client.getWithEtag(path);
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
			await this.client.putIfMatch(path, { ...writableFields(inst), devices }, etag);
		}

		try {
			await this.client.request(
				"DELETE",
				`/1.0/storage-pools/${enc(this.pool)}/volumes/custom/${enc(dockerVolume)}`,
			);
		} catch (err) {
			if (!(err instanceof IncusError && err.code === "NOT_FOUND")) {
				throw err;
			}
		}

		await this.ensureDockerVolume(name, opts.dockerGiB);

		await this.client.request("PATCH", path, {
			devices: { docker: this.dockerDevice(name) },
		});
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
	): Promise<RebuildInstanceResponse> {
		validateName(name);
		const inst = (await this.client.request(
			"GET",
			`/1.0/instances/${enc(name)}`,
		)) as InstanceConfig;
		assertStopped(name, inst.status);

		const imageFingerprint = await this.imageFingerprint();

		if (opts.resetDocker) {
			await this.resetDocker(name, { dockerGiB: opts.dockerGiB });
		}

		await this.client.request(
			"POST",
			`/1.0/instances/${enc(name)}/rebuild`,
			{ source: { type: "image", alias: this.imageAlias } },
			undefined,
			REBUILD_TIMEOUT_SECONDS,
		);
		this.log.info({ instance: name, imageFingerprint }, "instance rebuilt");

		return { imageFingerprint };
	}

	async setCpuAllowance(name: string, allowance: string | null): Promise<void> {
		validateName(name);
		// Checked again here: a percentage is only a soft share (ADR 0032).
		if (allowance !== null && !CpuAllowance.safeParse(allowance).success) {
			throw new IncusError("BAD_REQUEST", `invalid cpu allowance: ${allowance}`);
		}
		await this.writeCpuAllowance(name, allowance);
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
				wait: () => new Promise((r) => setTimeout(r, 1000)),
			});
		} catch (err) {
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
				{ instance: name, err: err instanceof Error ? err.message : String(err) },
				"could not read the instance's memory.stat; reporting usage with cache",
			);
			return Math.max(0, Math.trunc(usage));
		}
	}

	private async ensureVolume(
		volName: string,
		sizeGiB: number,
		extraConfig: Record<string, string> = {},
	): Promise<void> {
		try {
			await this.client.request(
				"POST",
				`/1.0/storage-pools/${enc(this.pool)}/volumes/custom`,
				{
					name: volName,
					config: { size: `${sizeGiB}GiB`, ...extraConfig },
				},
				undefined,
				undefined,
				VOLUME_CREATE_TIMEOUT_MS,
			);
		} catch (err) {
			if (err instanceof IncusError && err.code === "ALREADY_EXISTS") {
				return;
			}
			throw err;
		}
	}

	/**
	 * Make `<name>-docker` as a thin copy of the seed when one exists, sized
	 * at the Docker size plus the seed's, else empty (issue #840). A volume
	 * that already exists is kept, never replaced. A copy that fails falls
	 * back to an empty volume, so a broken seed never blocks a workspace.
	 * The copy is only ever attached as this one instance's Docker device.
	 */
	private async ensureDockerVolume(name: string, dockerGiB: number): Promise<void> {
		const volume = `${name}-docker`;
		let seed: SeedInfo | null = null;
		try {
			seed = await this.seedInfo();
		} catch (err) {
			this.log.warn(
				{ instance: name, err: err instanceof Error ? err.message : String(err) },
				"could not read the Docker seed; making an empty Docker volume",
			);
		}
		if (seed) {
			try {
				// A copy cannot be smaller than its source, which is the build volume's size.
				const source = (await this.client.request(
					"GET",
					this.volumePath(SEED_VOLUME_NAME),
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
					undefined,
					undefined,
					VOLUME_CREATE_TIMEOUT_MS,
				);
				return;
			} catch (err) {
				if (err instanceof IncusError && err.code === "ALREADY_EXISTS") return;
				this.log.warn(
					{ instance: name, err: err instanceof Error ? err.message : String(err) },
					"could not copy the Docker seed; making an empty Docker volume",
				);
				// A half-made copy would otherwise be adopted below.
				await this.client.request("DELETE", this.volumePath(volume)).catch(() => {});
			}
		}
		await this.ensureVolume(volume, dockerGiB);
	}

	async seedInfo(): Promise<SeedInfo | null> {
		let volume: { config?: Record<string, string> };
		try {
			volume = (await this.client.request(
				"GET",
				this.volumePath(SEED_VOLUME_NAME),
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

	async prepareSeedBuilder(opts: { maxBytes: number; ghcr: boolean }): Promise<void> {
		// A build the controller forgot (a restart) leaves these behind.
		await this.discardSeedBuild();
		// One GiB over the cap, so an oversize seed fails the size check with a
		// clear message rather than filling the volume.
		// Shifted from the start, so files keep real owners when copies are attached elsewhere.
		await this.ensureVolume(
			SEED_BUILD_VOLUME,
			Math.ceil(opts.maxBytes / 1024 ** 3) + 1,
			{
				"security.shifted": "true",
			},
		);
		// An ordinary workspace container: the workspace profile (network, ACL,
		// unprivileged, isolated idmap) and nothing that loosens it (S8).
		await this.client.request(
			"POST",
			"/1.0/instances",
			{
				name: SEED_BUILDER,
				source: { type: "image", alias: this.imageAlias },
				profiles: [this.profile],
				devices: {
					docker: {
						type: "disk",
						pool: this.pool,
						source: SEED_BUILD_VOLUME,
						path: "/var/lib/docker",
					},
				},
			},
			undefined,
			INSTANCE_CREATE_WAIT_SECONDS,
		);
		const seedGhcr = await writeDockerConfig(
			this.client,
			SEED_BUILDER,
			{ hubMirror: true, ghcr: opts.ghcr },
			{ caPath: this.ghcrCaPath, cacheOffPath: this.cacheOffPath, log: this.log },
		);
		await this.client.request(
			"PUT",
			`/1.0/instances/${SEED_BUILDER}/state`,
			{ action: "start" },
			undefined,
			SEED_BUILDER_START_SECONDS,
		);
		const deadline = Date.now() + SEED_BUILDER_START_SECONDS * 1000;
		await this.waitForAddress(
			SEED_BUILDER,
			deadline,
			AbortSignal.timeout(SEED_BUILDER_START_SECONDS * 1000),
		);
		// The first start ran the image's /etc/hosts template over our line.
		await writeGhcrHosts(this.client, SEED_BUILDER, seedGhcr);
		while ((await this.execInSeedBuilder(["/usr/bin/docker", "info"], 30)) !== 0) {
			if (Date.now() >= deadline) {
				throw new IncusError("TIMEOUT", "dockerd in the seed builder did not start");
			}
			await new Promise((r) => setTimeout(r, 1000));
		}
	}

	async execInSeedBuilder(command: string[], timeoutSeconds: number): Promise<number> {
		const result = await this.client.request(
			"POST",
			`/1.0/instances/${SEED_BUILDER}/exec`,
			{
				command,
				"wait-for-websocket": false,
				"record-output": false,
				interactive: false,
			},
			undefined,
			timeoutSeconds,
		);
		// No reported status is not a success for a build step.
		return execExitStatus(result) ?? -1;
	}

	async seedImageVersion(): Promise<string> {
		const image = await readCurrentImage(this.client, this.imageAlias);
		const version = image.serial ?? image.fingerprint;
		if (!version) throw new IncusError("IMAGE_NOT_FOUND", "no workspace image");
		return version.slice(0, 100);
	}

	async finishSeedBuilder(): Promise<number> {
		const state = (await this.client.request(
			"GET",
			`${this.volumePath(SEED_BUILD_VOLUME)}/state`,
		)) as { usage?: { used?: number } } | undefined;
		const used = state?.usage?.used;
		if (typeof used !== "number" || !(used >= 0)) {
			throw new IncusError("OPERATION_FAILED", "Incus did not report the seed's size");
		}
		// dockerd is already stopped, so a clean stop is quick.
		await this.stop(SEED_BUILDER, { timeoutSeconds: 60 });
		await this.client.request("DELETE", `/1.0/instances/${SEED_BUILDER}`);
		return Math.trunc(used);
	}

	async installSeed(info: SeedInfo): Promise<void> {
		// A shifted volume must never be attached to two instances (S4); the
		// builder is gone, so nothing may still use the build volume.
		const build = (await this.client.request(
			"GET",
			this.volumePath(SEED_BUILD_VOLUME),
		)) as { used_by?: string[] };
		if ((build.used_by ?? []).length > 0) {
			throw new VolumeInUseError(SEED_BUILD_VOLUME);
		}
		await this.client.request("PATCH", this.volumePath(SEED_BUILD_VOLUME), {
			config: { [SEED_INFO_KEY]: JSON.stringify(info) },
		});
		// Copies already made are independent of the old seed (spike #840).
		await this.deleteVolumeIfPresent(SEED_OLD_VOLUME);
		const hadSeed = await this.volumeExists(SEED_VOLUME_NAME);
		if (hadSeed) {
			await this.client.request("POST", this.volumePath(SEED_VOLUME_NAME), {
				name: SEED_OLD_VOLUME,
			});
		}
		try {
			await this.client.request("POST", this.volumePath(SEED_BUILD_VOLUME), {
				name: SEED_VOLUME_NAME,
			});
		} catch (err) {
			// Put the old seed back, so new workspaces still get one.
			if (hadSeed) {
				await this.client
					.request("POST", this.volumePath(SEED_OLD_VOLUME), { name: SEED_VOLUME_NAME })
					.catch((restoreErr: unknown) =>
						this.log.warn(
							{
								err:
									restoreErr instanceof Error ? restoreErr.message : String(restoreErr),
							},
							"could not restore the previous Docker seed",
						),
					);
			}
			throw err;
		}
		try {
			await this.deleteVolumeIfPresent(SEED_OLD_VOLUME);
		} catch (err) {
			this.log.warn(
				{ err: err instanceof Error ? err.message : String(err) },
				"could not delete the previous Docker seed; the next build retries",
			);
		}
		this.log.info({ sizeBytes: info.sizeBytes }, "docker seed installed");
	}

	async discardSeedBuild(): Promise<void> {
		try {
			await this.client.request(
				"PUT",
				`/1.0/instances/${SEED_BUILDER}/state`,
				{ action: "stop", force: true, timeout: 30 },
				undefined,
				60,
			);
		} catch (err) {
			if (err instanceof IncusError && err.code === "NOT_FOUND") {
				await this.deleteVolumeIfPresent(SEED_BUILD_VOLUME);
				return;
			}
			// Already stopped: Incus refuses to stop it again; the delete decides.
		}
		try {
			await this.client.request("DELETE", `/1.0/instances/${SEED_BUILDER}`);
		} catch (err) {
			if (!(err instanceof IncusError && err.code === "NOT_FOUND")) throw err;
		}
		await this.deleteVolumeIfPresent(SEED_BUILD_VOLUME);
	}

	private async deleteVolumeIfPresent(volume: string): Promise<void> {
		try {
			await this.client.request("DELETE", this.volumePath(volume));
		} catch (err) {
			if (!(err instanceof IncusError && err.code === "NOT_FOUND")) throw err;
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
	): Promise<GrowVolumesResponse> {
		validateName(name);
		return growVolumes(this.client, this.pool, name, sizes);
	}

	/**
	 * Set the instance's own limits, never the profile's; Incus applies them
	 * live to a running container. Null removes the key so the profile applies.
	 */
	async setLimits(name: string, limits: SetInstanceLimitsRequest): Promise<void> {
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
		const { metadata, etag } = await this.client.getWithEtag(path);
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
		await this.client.putIfMatch(path, { ...writableFields(inst), config }, etag);
		this.log.info({ instance: name, ...limits }, "instance limits set");
	}

	async addedPackages(name: string): Promise<AddedPackagesResponse> {
		validateName(name);
		let file: Awaited<ReturnType<IncusClient["readFile"]>>;
		try {
			file = await this.client.readFile(
				name,
				ADDED_PACKAGES_PATH,
				ADDED_PACKAGES_MAX_BYTES,
			);
		} catch (err) {
			// No list before the student's first apt run is normal, not an error.
			if (err instanceof IncusError && err.code === "NOT_FOUND") {
				return { image: null, packages: [] };
			}
			throw err;
		}
		// A symbolic link or directory there is not the hook's list.
		if (file.type !== "file") return { image: null, packages: [] };
		if (file.tooLarge) {
			throw new IncusError("BAD_REQUEST", "the added-packages list is over 64 KiB");
		}
		const { image, packages } = parseAptList(file.content.toString("utf8"));
		return { image, packages };
	}

	private volumePath(volume: string): string {
		return `/1.0/storage-pools/${enc(this.pool)}/volumes/custom/${enc(volume)}`;
	}

	private async volumeExists(volume: string): Promise<boolean> {
		try {
			await this.client.request("GET", this.volumePath(volume));
			return true;
		} catch (err) {
			if (err instanceof IncusError && err.code === "NOT_FOUND") return false;
			throw err;
		}
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
				`${this.volumePath(volume.name)}/snapshots?recursion=1`,
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
			`${this.volumePath(volume)}/snapshots/${enc(snapshot)}`,
		);
		this.log.info({ volume, snapshot }, "snapshot deleted");
	}

	async deleteKeptHome(volume: string): Promise<void> {
		if (!KeptHomeVolumeName.safeParse(volume).success) {
			throw new IncusError("BAD_REQUEST", "only kept homes can be deleted");
		}
		const info = (await this.client.request("GET", this.volumePath(volume))) as {
			used_by?: string[];
		};
		if ((info.used_by ?? []).length > 0) {
			throw new VolumeInUseError(volume);
		}
		await this.client.request("DELETE", this.volumePath(volume));
		this.log.info({ volume }, "kept home deleted");
	}

	/**
	 * Swap an imported home in the way Reset Docker swaps Docker's: detach
	 * home, keep the old volume under a new name, rename the import, attach.
	 * Each step can be repeated, so a retry finishes a half-done swap.
	 */
	async replaceHome(name: string): Promise<ReplaceHomeResponse> {
		validateName(name);
		const path = `/1.0/instances/${enc(name)}`;
		const homeVolume = `${name}-home`;
		const importVolume = `${name}-home-import`;
		const { metadata, etag } = await this.client.getWithEtag(path);
		const inst = metadata as InstanceConfig;
		assertStopped(name, inst.status);

		const home = inst.devices?.home;
		if (home && (home.source !== homeVolume || home.pool !== this.pool)) {
			throw new IncusError(
				"OPERATION_FAILED",
				`instance ${name} has an unexpected home device; refusing to replace it`,
			);
		}
		const importExists = await this.volumeExists(importVolume);
		if (home && !importExists) {
			throw new IncusError("NOT_FOUND", `volume ${importVolume} not found`);
		}

		if (home) {
			const { home: _removed, ...devices } = inst.devices;
			await this.client.putIfMatch(path, { ...writableFields(inst), devices }, etag);
		}

		if (importExists && (await this.volumeExists(homeVolume))) {
			const keptName = `${name}-home-replaced-${Math.floor(Date.now() / 1000)}`;
			await this.client.request("POST", this.volumePath(homeVolume), {
				name: keptName,
			});
		}
		if (importExists) {
			await this.client.request("POST", this.volumePath(importVolume), {
				name: homeVolume,
			});
		}

		await this.client.request("PATCH", path, {
			devices: { home: this.homeDevice(name) },
		});

		const kept = await this.newestKeptHome(name);
		if (!kept) {
			throw new IncusError("OPERATION_FAILED", `no kept home for ${name}`);
		}
		this.log.info({ instance: name, kept }, "home replaced");
		return { kept };
	}

	private async newestKeptHome(name: string): Promise<string | null> {
		const volumes = (await this.client.request(
			"GET",
			`/1.0/storage-pools/${enc(this.pool)}/volumes/custom?recursion=1`,
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
	 * both read on the host (issue #887).
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

	/** Restart the agent unit inside a running instance (issue #887). */
	async restartAgent(name: string): Promise<void> {
		validateName(name);
		const result = await this.client.request(
			"POST",
			`/1.0/instances/${enc(name)}/exec`,
			{
				command: ["systemctl", "restart", "portikus-workspace-agent.service"],
				"wait-for-websocket": false,
				"record-output": false,
				interactive: false,
			},
			undefined,
			AGENT_RESTART_TIMEOUT_SECONDS,
		);
		const status = execExitStatus(result);
		if (status !== null && status !== 0) {
			throw new IncusError("OPERATION_FAILED", `systemctl restart exited ${status}`);
		}
	}
}
