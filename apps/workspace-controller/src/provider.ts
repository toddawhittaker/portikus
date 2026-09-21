import {
	type CreateInstanceResponse,
	InstanceName,
	type InstanceStatus,
	isSystemTimezone,
	type StartInstanceResponse,
	type StopInstanceResponse,
} from "@portikus/contracts";
import { type Logger, silentLogger } from "@portikus/observability";
import { type IncusClient, IncusError } from "./incus.js";

export interface WorkspaceProvider {
	create(
		name: string,
		sizes: { homeGiB: number; dockerGiB: number },
	): Promise<CreateInstanceResponse>;
	start(
		name: string,
		opts: {
			timeoutSeconds: number;
			agentToken: string;
			hostname: string;
			previewHostSuffix: string;
			timezone: string;
		},
	): Promise<StartInstanceResponse>;
	stop(name: string, opts: { timeoutSeconds: number }): Promise<StopInstanceResponse>;
	list(): Promise<InstanceStatus[]>;
	healthy(): Promise<boolean>;
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

export class IncusWorkspaceProvider implements WorkspaceProvider {
	private readonly client: IncusClient;
	private readonly pool: string;
	private readonly profile: string;
	private readonly imageAlias: string;
	private readonly agentPort: number;
	private readonly log: Logger;

	constructor(opts: {
		client: IncusClient;
		pool: string;
		profile: string;
		imageAlias: string;
		agentPort: number;
		logger?: Logger;
	}) {
		this.client = opts.client;
		this.pool = opts.pool;
		this.profile = opts.profile;
		this.imageAlias = opts.imageAlias;
		this.agentPort = opts.agentPort;
		this.log = opts.logger ?? silentLogger();
	}

	async create(
		name: string,
		sizes: { homeGiB: number; dockerGiB: number },
	): Promise<CreateInstanceResponse> {
		validateName(name);

		await this.ensureVolume(`${name}-home`, sizes.homeGiB);
		await this.ensureVolume(`${name}-docker`, sizes.dockerGiB);

		let aliasData: { target: string };
		try {
			aliasData = (await this.client.request(
				"GET",
				`/1.0/images/aliases/${enc(this.imageAlias)}`,
			)) as { target: string };
		} catch (err) {
			if (err instanceof IncusError && err.code === "NOT_FOUND") {
				throw new IncusError(
					"IMAGE_NOT_FOUND",
					`image alias ${this.imageAlias} not found`,
				);
			}
			throw err;
		}
		const imageFingerprint = aliasData.target;

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
					docker: {
						type: "disk",
						pool: this.pool,
						source: `${name}-docker`,
						path: "/var/lib/docker",
					},
				},
			});
		} catch (err) {
			if (err instanceof IncusError && err.code === "ALREADY_EXISTS") {
				return {
					created: false,
					imageFingerprint,
					quota: sizes,
				};
			}
			throw err;
		}

		return { created: true, imageFingerprint, quota: sizes };
	}

	async start(
		name: string,
		opts: {
			timeoutSeconds: number;
			agentToken: string;
			hostname: string;
			previewHostSuffix: string;
			timezone: string;
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
			`export PORTIKUS_PREVIEW=true\nexport PORTIKUS_PREVIEW_HOST_SUFFIX=${opts.previewHostSuffix}\nexport TZ=${opts.timezone}\n`,
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

		await this.waitForAgent(ipv4, opts.agentToken);

		return { ipv4 };
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
}
