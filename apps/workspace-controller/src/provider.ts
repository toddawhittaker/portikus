import { availableParallelism } from "node:os";
import {
	CpuAllowance,
	type CreateInstanceResponse,
	type GrowVolumesRequest,
	type GrowVolumesResponse,
	type HostSnapshot,
	InstanceName,
	type InstanceProcess,
	type InstanceStatus,
	type InstanceUsage,
	isSystemTimezone,
	type RebuildInstanceResponse,
	type StartInstanceResponse,
	type StopInstanceResponse,
} from "@portikus/contracts";
import { type Logger, silentLogger } from "@portikus/observability";
import {
	countIncusCpus,
	growVolumes,
	parseIncusSize,
	readHostSnapshot,
	readInactiveFileBytes,
} from "./host.js";
import { type IncusClient, IncusError } from "./incus.js";
import {
	PROCESS_SNAPSHOT_SCRIPT,
	parseProcessOutput,
	STUDENT_UID,
} from "./processes.js";

export interface WorkspaceProvider {
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

/** The most process output read back from Incus (docs/EPIC-21.md ruling 17). */
export const PROCESS_OUTPUT_MAX_BYTES = 4 * 1024 * 1024;

/** How long Incus may take to run the one-second process sample. */
const PROCESS_EXEC_TIMEOUT_SECONDS = 8;

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
 * How long the agent has to answer /health once the instance is running. This
 * is its own budget, not the rest of the start timeout, so one broken agent
 * cannot hold the worker's serial start loop for the whole start deadline.
 */
export const AGENT_HEALTH_TIMEOUT_MS = 15_000;

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

/**
 * The recorded output logs an exec named in its metadata, kept only when
 * they are this instance's exec logs, so nothing else is read or deleted.
 */
export function recordedOutputPaths(
	name: string,
	result: unknown,
): { stdout: string | null; all: string[] } {
	const output = (result as { metadata?: { output?: unknown } } | undefined)?.metadata
		?.output;
	const prefix = `/1.0/instances/${enc(name)}/logs/`;
	const pick = (value: unknown): string | null => {
		if (typeof value !== "string") return null;
		const path = value.split("?")[0] ?? "";
		const file = path.slice(prefix.length);
		return path.startsWith(prefix) &&
			/^[A-Za-z0-9._/-]+$/.test(file) &&
			!file.includes("..")
			? path
			: null;
	};
	const record = (output ?? {}) as Record<string, unknown>;
	const stdout = pick(record["1"]);
	const stderr = pick(record["2"]);
	return { stdout, all: [stdout, stderr].filter((p): p is string => p !== null) };
}

export class IncusWorkspaceProvider implements WorkspaceProvider {
	private readonly client: IncusClient;
	private readonly pool: string;
	private readonly profile: string;
	private readonly imageAlias: string;
	private readonly agentPort: number;
	private readonly log: Logger;
	private readonly cgroupRoot: string;
	private readonly hostCpuCount: number;

	constructor(opts: {
		client: IncusClient;
		pool: string;
		profile: string;
		imageAlias: string;
		agentPort: number;
		logger?: Logger;
		/** Where the host's cgroup tree is mounted; tests point it elsewhere. */
		cgroupRoot?: string;
		/** CPUs on the host, for an instance with no `limits.cpu`. */
		hostCpuCount?: number;
	}) {
		this.client = opts.client;
		this.pool = opts.pool;
		this.profile = opts.profile;
		this.imageAlias = opts.imageAlias;
		this.agentPort = opts.agentPort;
		this.log = opts.logger ?? silentLogger();
		this.cgroupRoot = opts.cgroupRoot ?? "/sys/fs/cgroup";
		this.hostCpuCount = opts.hostCpuCount ?? availableParallelism();
	}

	async create(
		name: string,
		sizes: { homeGiB: number; dockerGiB: number; recoveryGiB: number },
	): Promise<CreateInstanceResponse> {
		validateName(name);

		await this.ensureVolume(`${name}-home`, sizes.homeGiB);
		await this.ensureVolume(`${name}-docker`, sizes.dockerGiB);
		await this.ensureVolume(`${name}-recovery`, sizes.recoveryGiB);

		const imageFingerprint = await this.imageFingerprint();
		const quota = { homeGiB: sizes.homeGiB, dockerGiB: sizes.dockerGiB };

		try {
			await this.client.request("POST", "/1.0/instances", {
				name,
				source: { type: "image", alias: this.imageAlias },
				profiles: [this.profile],
				devices: {
					home: {
						type: "disk",
						pool: this.pool,
						source: `${name}-home`,
						path: "/home/student",
					},
					docker: this.dockerDevice(name),
					recovery: this.recoveryDevice(name),
				},
			});
		} catch (err) {
			if (err instanceof IncusError && err.code === "ALREADY_EXISTS") {
				return { created: false, imageFingerprint, quota };
			}
			throw err;
		}

		return { created: true, imageFingerprint, quota };
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

		const recoveryAttached =
			opts.recoveryGiB !== undefined &&
			(await this.ensureRecoveryDevice(name, opts.recoveryGiB, signal));

		// A throttle never outlives a stop: every start begins at full speed.
		await this.writeCpuAllowance(name, null, signal);

		await this.client.request(
			"PUT",
			`/1.0/instances/${enc(name)}/state`,
			{ action: "start" },
			signal,
			opts.timeoutSeconds,
		);

		const deadline = Date.now() + opts.timeoutSeconds * 1000;
		const ipv4 = await this.waitForAddress(name, deadline, signal);

		await this.setHostname(name, opts.hostname, signal, opts.timeoutSeconds);

		await this.setTimezone(name, opts.timezone, signal, opts.timeoutSeconds);

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
		await this.ensureVolume(`${name}-docker`, sizeGiB);
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
		const current = (await this.client.request(
			"GET",
			`/1.0/instances/${enc(name)}/state`,
		)) as { status: string };
		if (current.status === "Stopped") {
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
			return { forced: true };
		}
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

		await this.ensureVolume(dockerVolume, opts.dockerGiB);

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
	): Promise<void> {
		const path = `/1.0/instances/${enc(name)}`;
		const { metadata, etag } = await this.client.getWithEtag(path, signal);
		const inst = metadata as InstanceConfig;
		const { [CPU_ALLOWANCE_KEY]: current, ...config } = inst.config ?? {};
		if ((current ?? null) === allowance) {
			return;
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
	 * Read the instance's processes through one Incus exec (ADR 0037). It runs
	 * as the student, with a fixed command and no caller input, and its output
	 * is read from Incus's recorded log, which is deleted afterwards.
	 */
	async processes(name: string, signal?: AbortSignal): Promise<InstanceProcess[]> {
		validateName(name);
		const inst = (await this.client.request(
			"GET",
			`/1.0/instances/${enc(name)}`,
			undefined,
			signal,
		)) as { status?: string; expanded_config?: Record<string, string> };
		if (inst.status !== "Running") {
			throw new IncusError("OPERATION_FAILED", `instance ${name} is not running`);
		}
		const cpuLimit =
			countIncusCpus(inst.expanded_config?.["limits.cpu"]) ?? this.hostCpuCount;

		const result = await this.client.request(
			"POST",
			`/1.0/instances/${enc(name)}/exec`,
			{
				command: ["/bin/sh", "-c", PROCESS_SNAPSHOT_SCRIPT],
				environment: { PATH: "/usr/bin:/bin", LANG: "C" },
				user: STUDENT_UID,
				group: STUDENT_UID,
				cwd: "/",
				"wait-for-websocket": false,
				"record-output": true,
				interactive: false,
			},
			signal,
			PROCESS_EXEC_TIMEOUT_SECONDS,
		);
		const logs = recordedOutputPaths(name, result);
		try {
			const status = execExitStatus(result);
			if (status !== 0) {
				throw new IncusError("OPERATION_FAILED", `process read exited ${status}`);
			}
			if (!logs.stdout) {
				throw new IncusError("OPERATION_FAILED", "Incus recorded no process output");
			}
			const output = await this.client.getBytes(
				logs.stdout,
				PROCESS_OUTPUT_MAX_BYTES,
				signal,
			);
			try {
				return parseProcessOutput(output.toString("utf8"), cpuLimit);
			} catch (err) {
				throw new IncusError(
					"OPERATION_FAILED",
					err instanceof Error ? err.message : "bad process output",
				);
			}
		} finally {
			for (const path of logs.all) {
				await this.client.request("DELETE", path).catch((err: unknown) => {
					this.log.warn(
						{ instance: name, err: err instanceof Error ? err.message : String(err) },
						"could not delete an exec output log",
					);
				});
			}
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

	private async ensureVolume(volName: string, sizeGiB: number): Promise<void> {
		try {
			await this.client.request(
				"POST",
				`/1.0/storage-pools/${enc(this.pool)}/volumes/custom`,
				{
					name: volName,
					config: { size: `${sizeGiB}GiB` },
				},
			);
		} catch (err) {
			if (err instanceof IncusError && err.code === "ALREADY_EXISTS") {
				return;
			}
			throw err;
		}
	}

	async hostSnapshot(): Promise<HostSnapshot> {
		return readHostSnapshot(this.client, {
			pool: this.pool,
			profile: this.profile,
			imageAlias: this.imageAlias,
		});
	}

	async growVolumes(
		name: string,
		sizes: GrowVolumesRequest,
	): Promise<GrowVolumesResponse> {
		validateName(name);
		return growVolumes(this.client, this.pool, name, sizes);
	}
}
