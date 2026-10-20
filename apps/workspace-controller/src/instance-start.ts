// Starting an instance: devices, start files, network and agent readiness (SPEC.md §6.3).
import {
	CpuAllowance,
	isSystemTimezone,
	type StartInstanceResponse,
	type WorkspaceDockerConfig,
} from "@portikus/contracts";
import { errorMessage } from "@portikus/observability";
import {
	writeAgentInstructions,
	writeClaudeManagedSettings,
} from "./agent-instructions.js";
import { writeCodingAgentLinks } from "./coding-agent-links.js";
import { writeDockerConfig, writeGhcrHosts } from "./docker-config.js";
import { ensureDockerVolume } from "./docker-volume.js";
import { ensureVolume } from "./host.js";
import { IncusError } from "./incus.js";
import { writeCpuAllowance } from "./instance-usage.js";
import {
	dockerDevice,
	enc,
	type InstanceConfig,
	instanceStatus,
	type ProviderHost,
	recoveryDevice,
	validateName,
} from "./provider-host.js";
import {
	prepareRecoveryMount,
	setHostname,
	setTimezone,
	waitForAddress,
	waitForAgent,
	withCaller,
	writeStartFiles,
} from "./start-setup.js";

/** A lowercase DNS label; anything else must never reach the container. */
const HOSTNAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/** A lowercase DNS name, checked again here as defence in depth. */
const DNS_NAME_PATTERN =
	/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

export async function startInstance(
	host: ProviderHost,
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
	if ((await instanceStatus(host, name, signal)) === "Running") {
		await host.client.request(
			"PUT",
			`/1.0/instances/${enc(name)}/state`,
			{ action: "stop", force: true },
			signal,
			opts.timeoutSeconds,
		);
		host.log.info({ instance: name }, "running instance stopped before a start");
	}

	if (opts.dockerGiB !== undefined) {
		await ensureDockerDevice(host, name, opts.dockerGiB, signal);
	}

	// Written before the start, so dockerd reads it; never fatal.
	const docker = opts.docker;
	let ghcr: boolean | null = null;
	if (docker !== undefined) {
		ghcr =
			(await optionalStep(
				host,
				name,
				signal,
				"could not write the Docker registry settings; starting without them",
				() =>
					writeDockerConfig(
						host.client,
						name,
						docker,
						{
							caPath: host.ghcrCaPath,
							cacheOffPath: host.cacheOffPath,
							log: host.log,
						},
						signal,
					),
			)) ?? null;
	}

	// Rewritten at every start, so an edit or deletion lasts one session.
	const written = await optionalStep(
		host,
		name,
		signal,
		"could not write the coding-agent instructions; starting without them",
		() => writeAgentInstructions(host.client, name, host.agentInstructionsPath, signal),
	);
	if (written === false) {
		host.log.warn(
			{ instance: name, path: host.agentInstructionsPath },
			"the coding-agent instructions template is missing; starting without them",
		);
	}

	// Repointed at every start, so a workspace on an older image moves to the shared tools.
	await optionalStep(
		host,
		name,
		signal,
		"could not link the shared coding agents; starting with the image's own",
		() => writeCodingAgentLinks(host.client, name, host.codingAgentsBinPath, signal),
	);

	// Rewritten at every start, so a deleted /etc/claude-code gets its settings back.
	const settingsWritten = await optionalStep(
		host,
		name,
		signal,
		"could not write Claude Code's managed settings; starting without them",
		() =>
			writeClaudeManagedSettings(
				host.client,
				name,
				host.claudeManagedSettingsPath,
				signal,
			),
	);
	if (settingsWritten === false) {
		host.log.warn(
			{ instance: name, path: host.claudeManagedSettingsPath },
			"Claude Code's managed settings template is missing; starting without them",
		);
	}

	await writeStartFiles(
		host.client,
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
		(await ensureRecoveryDevice(host, name, opts.recoveryGiB, signal));

	// A throttle ends at a stop unless the worker says it is held; a held
	// one is set before the instance runs, so it never runs at full speed.
	if (
		opts.cpuAllowance !== undefined &&
		!CpuAllowance.safeParse(opts.cpuAllowance).success
	) {
		throw new IncusError("BAD_REQUEST", `invalid cpu allowance: ${opts.cpuAllowance}`);
	}
	const status = await writeCpuAllowance(host, name, opts.cpuAllowance ?? null, signal);

	// Once the start request is sent, Incus starts the instance whatever the
	// caller does, so the setup below runs to the end on its own limits: the
	// worker's sweep would mark a half-set-up workspace running (ADR 0034).
	signal.throwIfAborted();
	try {
		// Something may have started it since the check above.
		if (status !== "Running") {
			try {
				await host.client.request(
					"PUT",
					`/1.0/instances/${enc(name)}/state`,
					{ action: "start" },
					own,
					opts.timeoutSeconds,
				);
			} catch (err) {
				if ((await instanceStatus(host, name, own).catch(() => null)) !== "Running") {
					throw err;
				}
			}
		}

		const deadline = Date.now() + opts.timeoutSeconds * 1000;
		const ipv4 = await waitForAddress(host.client, name, deadline, own);

		await setHostname(
			host.client,
			host.log,
			name,
			opts.hostname,
			opts.timeoutSeconds,
			own,
		);

		await setTimezone(host.client, name, opts.timezone, opts.timeoutSeconds, own);

		// After the start: a first start after create or copy runs the image's
		// /etc/hosts template, which would drop the line.
		if (ghcr !== null) {
			await optionalStep(
				host,
				name,
				own,
				"could not write the ghcr.io hosts line",
				() => writeGhcrHosts(host.client, name, ghcr, own),
			);
		}

		if (recoveryAttached) {
			await prepareRecoveryMount(host.client, host.log, name, opts.timeoutSeconds, own);
		}

		// The agent wait has its own 15 s, not the start's timeout.
		await waitForAgent(host.log, ipv4, host.agentPort, opts.agentToken);
		if (caller?.aborted) {
			host.log.info({ instance: name }, "start finished after the caller left");
		}

		return { ipv4 };
	} catch (err) {
		// A half-set-up instance must not stay running for the sweep to mark it running.
		await forceStopAfterFailedStart(host, name, opts.timeoutSeconds);
		throw err;
	}
}

async function forceStopAfterFailedStart(
	host: ProviderHost,
	name: string,
	timeoutSeconds: number,
): Promise<void> {
	try {
		await host.client.request(
			"PUT",
			`/1.0/instances/${enc(name)}/state`,
			{ action: "stop", force: true },
			AbortSignal.timeout(timeoutSeconds * 1000),
			timeoutSeconds,
		);
		host.log.info({ instance: name }, "instance stopped after a failed start");
	} catch (err) {
		host.log.warn(
			{ instance: name, err: errorMessage(err) },
			"could not stop the instance after a failed start",
		);
	}
}

/**
 * Run a start step whose failure only costs a feature: warn and go on.
 * An abort is not such a failure, so it ends the start (ADR 0034).
 */
async function optionalStep<T>(
	host: ProviderHost,
	name: string,
	signal: AbortSignal,
	message: string,
	step: () => Promise<T>,
): Promise<T | undefined> {
	try {
		return await step();
	} catch (err) {
		if (signal.aborted) throw err;
		host.log.warn({ instance: name, err: errorMessage(err) }, message);
		return undefined;
	}
}

/**
 * Put back a Docker volume that a failed Reset Docker left off (ADR 0021).
 * Unlike recovery this is fatal: Docker without its volume would fill the
 * root filesystem. The only volume it creates is `<name>-docker`.
 */
async function ensureDockerDevice(
	host: ProviderHost,
	name: string,
	sizeGiB: number,
	signal: AbortSignal,
): Promise<void> {
	const inst = (await host.client.request(
		"GET",
		`/1.0/instances/${enc(name)}`,
		undefined,
		signal,
	)) as InstanceConfig;
	if (inst.devices?.docker) {
		return;
	}
	await ensureDockerVolume(host, name, sizeGiB, signal);
	// PATCH merges devices, so it adds this one and cannot drop another.
	await host.client.request(
		"PATCH",
		`/1.0/instances/${enc(name)}`,
		{ devices: { docker: dockerDevice(host, name) } },
		signal,
	);
	host.log.info({ instance: name }, "docker volume re-attached");
}

/**
 * Give a workspace made before recovery volumes existed its recovery volume (ADR 0020).
 * Never fatal, so a new feature cannot lock a student out, and the only
 * volume it creates is `<name>-recovery`. Returns whether the device is on.
 */
async function ensureRecoveryDevice(
	host: ProviderHost,
	name: string,
	sizeGiB: number,
	signal: AbortSignal,
): Promise<boolean> {
	try {
		const inst = (await host.client.request(
			"GET",
			`/1.0/instances/${enc(name)}`,
			undefined,
			signal,
		)) as InstanceConfig;
		if (inst.devices?.recovery) {
			return true;
		}
		await ensureVolume(host.client, host.pool, `${name}-recovery`, sizeGiB, {}, signal);
		// PATCH merges devices, so it adds this one and cannot drop another.
		await host.client.request(
			"PATCH",
			`/1.0/instances/${enc(name)}`,
			{ devices: { recovery: recoveryDevice(host, name) } },
			signal,
		);
		host.log.info({ instance: name }, "recovery volume attached");
		return true;
	} catch (err) {
		if (signal.aborted) throw err;
		host.log.warn(
			{ instance: name, err: errorMessage(err) },
			"could not attach the recovery volume; starting without it",
		);
		return false;
	}
}
