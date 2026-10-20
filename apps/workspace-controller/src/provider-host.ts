// What the provider's parts share: the host they run against and small Incus instance helpers.
import { InstanceName } from "@portikus/contracts";
import type { Logger } from "@portikus/observability";
import { type IncusClient, IncusError } from "./incus.js";
import { RECOVERY_PATH } from "./start-setup.js";

/** The host and paths every part of the provider works against. */
export interface ProviderHost {
	client: IncusClient;
	pool: string;
	profile: string;
	imageAlias: string;
	agentPort: number;
	log: Logger;
	cgroupRoot: string;
	procRoot: string;
	hostCpuCount: number;
	thinPoolStatusPath: string | undefined;
	ghcrCaPath: string;
	cacheOffPath: string;
	agentInstructionsPath: string;
	claudeManagedSettingsPath: string;
	codingAgentsBinPath: string;
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

/** The fields of an instance that Incus accepts back in a PUT. */
export interface InstanceConfig {
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
export function writableFields(inst: InstanceConfig): InstanceConfig {
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

export function assertStopped(name: string, status: string | undefined): void {
	if (status !== "Stopped") {
		throw new InstanceNotStoppedError(name, status ?? "in an unknown state");
	}
}

export function validateName(name: string): void {
	const result = InstanceName.safeParse(name);
	if (!result.success) {
		throw new IncusError("INVALID_NAME", `invalid instance name: ${name}`);
	}
}

export function enc(name: string): string {
	return encodeURIComponent(name);
}

export function homeDevice(host: ProviderHost, name: string): Record<string, string> {
	return {
		type: "disk",
		pool: host.pool,
		source: `${name}-home`,
		path: "/home/student",
	};
}

export function dockerDevice(host: ProviderHost, name: string): Record<string, string> {
	return {
		type: "disk",
		pool: host.pool,
		source: `${name}-docker`,
		path: "/var/lib/docker",
	};
}

export function recoveryDevice(
	host: ProviderHost,
	name: string,
): Record<string, string> {
	return {
		type: "disk",
		pool: host.pool,
		source: `${name}-recovery`,
		path: RECOVERY_PATH,
	};
}

export async function instanceStatus(
	host: ProviderHost,
	name: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	const state = (await host.client.request(
		"GET",
		`/1.0/instances/${enc(name)}/state`,
		undefined,
		signal,
	)) as { status?: string } | undefined;
	return state?.status;
}
