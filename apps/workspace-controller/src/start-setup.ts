import { setTimeout as sleep } from "node:timers/promises";
import { errorMessage, type Logger } from "@portikus/observability";
import { type IncusClient, IncusError } from "./incus.js";

// The in-container steps of a workspace start.

/** The image's `student` user and group. */
export const STUDENT_UID = 1000;

/** Where the workspace agent reads its bearer token (ADR 0009). */
export const AGENT_TOKEN_PATH = "/etc/portikus/agent.token";

/**
 * Shell profile read by every login shell in the container, so a terminal,
 * a template, and a coding agent all see where previews are published
 * (BROWSER-HANDLING.md section 14). It never holds a secret.
 */
export const PROFILE_PATH = "/etc/profile.d/portikus.sh";

/** Where the recovery volume is mounted inside the container (ADR 0020). */
export const RECOVERY_PATH = "/var/lib/portikus/recovery";

/**
 * How long the agent has to answer /health once the instance is running. This
 * is its own budget, not the rest of the start timeout, so one broken agent
 * cannot hold the worker's serial start loop for the whole start deadline.
 */
export const AGENT_HEALTH_TIMEOUT_MS = 15_000;

const ROOT_FILE = { uid: 0, gid: 0, mode: "0644" };

/**
 * Write the hostname, timezone, shell profile, and agent token. The caller
 * must have stopped the container (SPEC.md §24); a pipe left at
 * /etc/hostname would also hang the container's own init at boot.
 */
export async function writeStartFiles(
	client: Pick<IncusClient, "replaceFile">,
	name: string,
	opts: {
		hostname: string;
		timezone: string;
		previewHostSuffix: string;
		agentToken: string;
	},
	signal?: AbortSignal,
): Promise<void> {
	await client.replaceFile(
		name,
		"/etc/hostname",
		`${opts.hostname}\n`,
		ROOT_FILE,
		signal,
	);
	await client.replaceFile(
		name,
		"/etc/timezone",
		`${opts.timezone}\n`,
		ROOT_FILE,
		signal,
	);
	await client.replaceFile(
		name,
		PROFILE_PATH,
		// TZ is a default, not an override: tmux sets the session's current
		// zone and a login shell sources this file afterwards, so a student
		// who changes their timezone must not get the start-time zone back.
		// The zone was validated against the system list.
		`export PORTIKUS_PREVIEW=true\n` +
			`export PORTIKUS_PREVIEW_HOST_SUFFIX=${opts.previewHostSuffix}\n` +
			`export TZ="\${TZ:-${opts.timezone}}"\n`,
		ROOT_FILE,
		signal,
	);
	await client.replaceFile(
		name,
		AGENT_TOKEN_PATH,
		opts.agentToken,
		{ uid: STUDENT_UID, gid: STUDENT_UID, mode: "0600" },
		signal,
	);
}

/** Poll the instance state until it is Running with a global IPv4 address. */
export async function waitForAddress(
	client: Pick<IncusClient, "request">,
	name: string,
	deadline: number,
	signal?: AbortSignal,
): Promise<string> {
	while (Date.now() < deadline) {
		const state = (await client.request(
			"GET",
			`/1.0/instances/${encodeURIComponent(name)}/state`,
			undefined,
			signal,
		)) as {
			status: string;
			network?: Record<
				string,
				{ addresses?: Array<{ family: string; address: string; scope: string }> }
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

		try {
			await sleep(500, undefined, { signal });
		} catch (err) {
			// The start's own limit ran out: report it as the timeout below. A caller's abort is rethrown.
			if (
				signal?.reason instanceof DOMException &&
				signal.reason.name === "TimeoutError"
			) {
				break;
			}
			throw err;
		}
	}

	throw new IncusError(
		"TIMEOUT",
		`instance ${name} did not reach Running with IPv4 before the start deadline`,
	);
}

/**
 * Name the container after the workspace label so the shell prompt reads
 * `student@<label>` (SPEC.md section 29). `writeStartFiles` covers the next
 * boot; this covers the current one, which the first boot after a create
 * needs because the image's template rewrites the file then. A failure only
 * costs the prompt its name, so it warns and the start carries on.
 */
export async function setHostname(
	client: Pick<IncusClient, "exec">,
	log: Logger,
	name: string,
	hostname: string,
	timeoutSeconds: number,
	signal?: AbortSignal,
): Promise<void> {
	const { status } = await client.exec(
		name,
		["hostname", hostname],
		{ timeoutSeconds },
		signal,
	);
	if (status !== null && status !== 0) {
		log.warn({ instance: name, status }, "could not set the hostname; starting anyway");
	}
}

/**
 * Run the container in the owner's timezone, so timestamps in a shell, in
 * logs, and on Git commits match the clock on the wall. `/etc/timezone` is
 * what the Debian tools read and `/etc/localtime` what the C library reads.
 * The zone name was checked against the known list, so it is safe here.
 */
export async function setTimezone(
	client: Pick<IncusClient, "exec">,
	name: string,
	timezone: string,
	timeoutSeconds: number,
	signal?: AbortSignal,
): Promise<void> {
	const { status } = await client.exec(
		name,
		["ln", "-sfn", `/usr/share/zoneinfo/${timezone}`, "/etc/localtime"],
		{ timeoutSeconds },
		signal,
	);

	// A missing zone file in the image makes `ln` fail, and the container
	// would then run in the wrong zone with nothing said.
	if (status !== null && status !== 0) {
		throw new IncusError(
			"OPERATION_FAILED",
			`could not set the timezone to ${timezone}: ` +
				`/usr/share/zoneinfo/${timezone} is missing from the image ` +
				`(ln exited ${status})`,
		);
	}
}

/**
 * A new volume's root belongs to root, and the agent runs as the student
 * (ADR 0020). Never fatal. chown and chmod fail when the mount is missing,
 * where `install -d` would quietly make a directory on the root filesystem.
 */
export async function prepareRecoveryMount(
	client: Pick<IncusClient, "exec">,
	log: Logger,
	name: string,
	timeoutSeconds: number,
	signal?: AbortSignal,
): Promise<void> {
	for (const command of [
		["chown", `${STUDENT_UID}:${STUDENT_UID}`, RECOVERY_PATH],
		["chmod", "0700", RECOVERY_PATH],
	]) {
		try {
			const { status } = await client.exec(name, command, { timeoutSeconds }, signal);
			if (status !== null && status !== 0) {
				throw new Error(`${command[0]} exited ${status}`);
			}
		} catch (err) {
			if (signal?.aborted) throw err;
			log.warn(
				{ instance: name, err: errorMessage(err) },
				"could not prepare the recovery mount",
			);
			return;
		}
	}
}

/**
 * Poll the workspace agent's /health until it answers 200 (SPEC.md 6.3).
 * `signal` only ends the wait early; the 15 s limit stays (ADR 0034).
 */
export async function waitForAgent(
	log: Logger,
	ipv4: string,
	agentPort: number,
	agentToken: string,
	signal?: AbortSignal,
): Promise<void> {
	const url = `http://${ipv4}:${agentPort}/health`;
	const deadline = Date.now() + AGENT_HEALTH_TIMEOUT_MS;
	let attempt = 0;
	while (Date.now() < deadline) {
		signal?.throwIfAborted();
		attempt += 1;
		log.debug({ ipv4, attempt }, "polling the workspace agent");
		try {
			const res = await fetch(url, {
				headers: { Authorization: `Bearer ${agentToken}` },
				signal: signal
					? AbortSignal.any([signal, AbortSignal.timeout(2000)])
					: AbortSignal.timeout(2000),
			});
			// Read the body so the connection is released either way.
			await res.arrayBuffer().catch(() => undefined);
			if (res.status === 200) {
				return;
			}
		} catch {
			// Agent not listening yet; retry until the deadline.
		}
		await sleep(1000, undefined, { signal });
	}

	throw new IncusError(
		"TIMEOUT",
		`workspace agent at ${ipv4} did not become healthy within ${AGENT_HEALTH_TIMEOUT_MS}ms`,
	);
}
