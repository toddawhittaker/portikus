/**
 * Listening-port discovery (SPEC.md §14.7, §18.2, BROWSER-HANDLING.md §11.1,
 * §17). Once a second the agent reads `/proc/net/tcp` and `/proc/net/tcp6`,
 * keeps the sockets in the LISTEN state, and works out which process and
 * which inner Docker container owns each one. Everything past the port list
 * is best effort: a `/proc` entry we cannot read is left out rather than
 * failing the scan.
 */
import { execFile } from "node:child_process";
import { readdir, readFile, readlink } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import type { AgentListeningService } from "@portikus/contracts";
import type { FastifyBaseLogger } from "fastify";

/** The TCP state `/proc` uses for a listening socket. */
const LISTEN_STATE = "0A";

/** How often the port list is rescanned. */
export const SCAN_INTERVAL_MS = 1000;

/** How long a Docker answer is reused before asking again. */
export const DOCKER_CACHE_MS = 5000;

/** How long `docker ps` may take before we give up on it for this scan. */
export const DOCKER_TIMEOUT_MS = 500;

/**
 * Ports that development servers use for plain HTTP often enough to label.
 * Anything else is "unknown"; the agent does not probe student services.
 */
const HTTP_PORTS: ReadonlySet<number> = new Set([
	80, 3000, 3001, 4000, 4200, 5000, 5173, 5174, 7000, 8000, 8001, 8080, 8081, 8888,
	9000,
]);

/** One listening socket as `/proc/net/tcp` reports it. */
export interface ProcListener {
	address: string;
	port: number;
	inode: string;
}

/** The process a socket inode belongs to. */
export interface SocketOwner {
	pid: number;
	command?: string;
}

/** A running inner Docker container and the host ports it publishes. */
export interface DockerContainer {
	id: string;
	name: string;
	ports: number[];
}

export type DockerLookup = () => Promise<DockerContainer[]>;

/**
 * Decode one `/proc/net/tcp` address. Addresses are hexadecimal 32-bit words
 * in host byte order, so each group of four bytes is reversed: eight hex
 * digits for IPv4, thirty-two for IPv6.
 */
export function decodeHexAddress(hex: string): string {
	if (hex.length !== 8 && hex.length !== 32) {
		throw new Error(`unexpected address length: ${hex.length}`);
	}
	const bytes: number[] = [];
	for (let word = 0; word < hex.length / 8; word += 1) {
		const chunk = hex.slice(word * 8, word * 8 + 8);
		for (let byte = 3; byte >= 0; byte -= 1) {
			bytes.push(Number.parseInt(chunk.slice(byte * 2, byte * 2 + 2), 16));
		}
	}
	if (bytes.length === 4) return bytes.join(".");
	return formatIpv6(bytes);
}

/** Format sixteen bytes as an IPv6 address, with the usual `::` shortening. */
function formatIpv6(bytes: number[]): string {
	const groups: string[] = [];
	for (let index = 0; index < 16; index += 2) {
		groups.push((((bytes[index] ?? 0) << 8) | (bytes[index + 1] ?? 0)).toString(16));
	}
	// Find the longest run of zero groups to replace with "::".
	let bestStart = -1;
	let bestLength = 0;
	let runStart = -1;
	for (let index = 0; index <= groups.length; index += 1) {
		if (index < groups.length && groups[index] === "0") {
			if (runStart < 0) runStart = index;
			continue;
		}
		if (runStart >= 0) {
			const length = index - runStart;
			if (length > bestLength) {
				bestStart = runStart;
				bestLength = length;
			}
			runStart = -1;
		}
	}
	if (bestLength < 2) return groups.join(":");
	const head = groups.slice(0, bestStart).join(":");
	const tail = groups.slice(bestStart + bestLength).join(":");
	return `${head}::${tail}`;
}

/** Parse the LISTEN rows out of a `/proc/net/tcp` or `tcp6` file. */
export function parseProcNetTcp(text: string): ProcListener[] {
	const listeners: ProcListener[] = [];
	for (const line of text.split("\n").slice(1)) {
		const fields = line.trim().split(/\s+/);
		// sl, local, remote, state, queues, timer, retransmit, uid, timeout, inode
		if (fields.length < 10) continue;
		if (fields[3] !== LISTEN_STATE) continue;
		const [hexAddress, hexPort] = (fields[1] ?? "").split(":");
		if (!hexAddress || !hexPort) continue;
		let address: string;
		try {
			address = decodeHexAddress(hexAddress);
		} catch {
			continue;
		}
		const port = Number.parseInt(hexPort, 16);
		if (!Number.isInteger(port) || port <= 0 || port > 65535) continue;
		listeners.push({ address, port, inode: fields[9] ?? "" });
	}
	return listeners;
}

/**
 * Map socket inodes to the process holding them, by walking `/proc/<pid>/fd`.
 * Directories and links we may not read are skipped.
 */
export async function readSocketOwners(
	procRoot: string,
): Promise<Map<string, SocketOwner>> {
	const owners = new Map<string, SocketOwner>();
	let entries: string[];
	try {
		entries = await readdir(procRoot);
	} catch {
		return owners;
	}
	for (const entry of entries) {
		const pid = Number.parseInt(entry, 10);
		if (!Number.isInteger(pid) || String(pid) !== entry) continue;
		let descriptors: string[];
		try {
			descriptors = await readdir(join(procRoot, entry, "fd"));
		} catch {
			continue;
		}
		let command: string | undefined;
		let commandRead = false;
		for (const descriptor of descriptors) {
			let target: string;
			try {
				target = await readlink(join(procRoot, entry, "fd", descriptor));
			} catch {
				continue;
			}
			const match = /^socket:\[(\d+)]$/.exec(target);
			if (!match) continue;
			if (!commandRead) {
				commandRead = true;
				command = await readComm(procRoot, entry);
			}
			// The first process found for an inode wins; a forked child holding
			// the same socket tells the student nothing extra.
			const inode = match[1] ?? "";
			if (!owners.has(inode)) owners.set(inode, { pid, command });
		}
	}
	return owners;
}

async function readComm(procRoot: string, pid: string): Promise<string | undefined> {
	try {
		const text = await readFile(join(procRoot, pid, "comm"), "utf8");
		const command = text.trim();
		return command === "" ? undefined : command;
	} catch {
		return undefined;
	}
}

/** Ask Docker which containers are running and what ports they publish. */
export async function dockerPs(): Promise<DockerContainer[]> {
	const stdout = await new Promise<string>((resolve, reject) => {
		execFile(
			"docker",
			["ps", "--format", "{{.ID}}\t{{.Names}}\t{{.Ports}}"],
			{ timeout: DOCKER_TIMEOUT_MS, encoding: "utf8" },
			(error, out) => {
				if (error) reject(error);
				else resolve(out);
			},
		);
	});
	return parseDockerPs(stdout);
}

/** Parse `docker ps` rows into containers and the host ports they publish. */
export function parseDockerPs(stdout: string): DockerContainer[] {
	const containers: DockerContainer[] = [];
	for (const line of stdout.split("\n")) {
		if (line.trim() === "") continue;
		const [id, name, ports] = line.split("\t");
		if (!id || !name) continue;
		const published = new Set<number>();
		// Rows look like "0.0.0.0:5432->5432/tcp, :::5432->5432/tcp".
		for (const match of (ports ?? "").matchAll(/:(\d+)->/g)) {
			published.add(Number.parseInt(match[1] ?? "0", 10));
		}
		containers.push({ id, name, ports: [...published] });
	}
	return containers;
}

/**
 * The address the preview gateway reaches this container on. Incus gives the
 * container one bridged interface, `eth0`; the agent itself binds `0.0.0.0`,
 * so this is the first place anything in the agent needs the real address.
 */
export function workspaceInterfaceAddress(): string | null {
	const interfaces = networkInterfaces();
	const preferred = interfaces.eth0 ?? [];
	for (const entry of preferred) {
		if (entry.family === "IPv4" && !entry.internal) return entry.address;
	}
	for (const [name, entries] of Object.entries(interfaces)) {
		if (name === "lo") continue;
		for (const entry of entries ?? []) {
			if (entry.family === "IPv4" && !entry.internal) return entry.address;
		}
	}
	return null;
}

function isLoopback(address: string): boolean {
	return address.startsWith("127.") || address === "::1";
}

function isWildcard(address: string): boolean {
	return address === "0.0.0.0" || address === "::";
}

export interface ListeningMonitorOptions {
	/** Where `/proc` is. Tests point this at a fixture tree. */
	procRoot?: string;
	/** The address the gateway reaches this container on. */
	interfaceAddress?: string | null;
	/** Which ports currently have a loopback forward open. */
	forwardedPorts?: () => ReadonlySet<number>;
	/** How Docker is queried. `null` turns the lookup off. */
	docker?: DockerLookup | null;
	intervalMs?: number;
	logger?: FastifyBaseLogger;
}

type Listener = (services: AgentListeningService[]) => void;

/** Everything about a service except when it was observed. */
function fingerprint(services: AgentListeningService[]): string {
	return JSON.stringify(services.map(({ observedAt: _observedAt, ...rest }) => rest));
}

/**
 * Scans for listening ports on a timer and tells its subscribers whenever the
 * set changes (BROWSER-HANDLING.md §17).
 */
export class ListeningMonitor {
	private readonly procRoot: string;
	private readonly interfaceAddress: string | null;
	private readonly forwardedPorts: () => ReadonlySet<number>;
	private readonly docker: DockerLookup | null;
	private readonly intervalMs: number;
	private readonly logger: FastifyBaseLogger | undefined;
	private readonly listeners = new Set<Listener>();
	private services: AgentListeningService[] = [];
	private print = fingerprint([]);
	private timer: NodeJS.Timeout | null = null;
	private dockerCache: { at: number; containers: DockerContainer[] } | null = null;

	constructor(options: ListeningMonitorOptions = {}) {
		this.procRoot = options.procRoot ?? "/proc";
		this.interfaceAddress =
			options.interfaceAddress === undefined
				? workspaceInterfaceAddress()
				: options.interfaceAddress;
		this.forwardedPorts = options.forwardedPorts ?? (() => new Set<number>());
		this.docker = options.docker === undefined ? dockerPs : options.docker;
		this.intervalMs = options.intervalMs ?? SCAN_INTERVAL_MS;
		this.logger = options.logger;
	}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => {
			void this.refresh();
		}, this.intervalMs);
		// The scan must not keep a shutting-down process alive.
		this.timer.unref();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		this.listeners.clear();
	}

	current(): AgentListeningService[] {
		return this.services;
	}

	subscribe(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** True when this port is listening on loopback and nowhere else. */
	isLoopbackOnly(port: number): boolean {
		const service = this.services.find((entry) => entry.port === port);
		if (!service) return false;
		return (
			service.addresses.some(isLoopback) &&
			!service.addresses.some((address) => !isLoopback(address))
		);
	}

	/**
	 * The loopback address a forward for this port must dial: `127.0.0.1` when
	 * an IPv4 loopback listener exists, otherwise `::1` when an IPv6 one does.
	 * Vite and others bind `localhost`, which on many systems is `::1` alone.
	 */
	loopbackTarget(port: number): string | null {
		const service = this.services.find((entry) => entry.port === port);
		if (!service) return null;
		if (service.addresses.some((address) => address.startsWith("127."))) {
			return "127.0.0.1";
		}
		if (service.addresses.includes("::1")) return "::1";
		return null;
	}

	/** True while something is still listening on loopback at this port. */
	hasLoopbackListener(port: number): boolean {
		const service = this.services.find((entry) => entry.port === port);
		return service?.addresses.some(isLoopback) ?? false;
	}

	/** One scan. Subscribers hear about it only if the set changed. */
	async refresh(): Promise<AgentListeningService[]> {
		let services: AgentListeningService[];
		try {
			services = await this.scan();
		} catch (error) {
			this.logger?.debug(
				{ error: error instanceof Error ? error.message : String(error) },
				"listening scan failed",
			);
			return this.services;
		}
		const print = fingerprint(services);
		if (print === this.print) return this.services;
		this.print = print;
		this.services = services;
		for (const listener of this.listeners) listener(services);
		return services;
	}

	private async scan(): Promise<AgentListeningService[]> {
		const rows = [
			...parseProcNetTcp(await this.readProcFile("net/tcp")),
			...parseProcNetTcp(await this.readProcFile("net/tcp6")),
		];
		const owners = await readSocketOwners(this.procRoot);
		const containers = await this.containers();
		const forwarded = this.forwardedPorts();
		const observedAt = new Date().toISOString();

		const byPort = new Map<number, ProcListener[]>();
		for (const row of rows) {
			const existing = byPort.get(row.port);
			if (existing) existing.push(row);
			else byPort.set(row.port, [row]);
		}

		const services: AgentListeningService[] = [];
		for (const [port, listeners] of byPort) {
			const addresses = [...new Set(listeners.map((entry) => entry.address))].sort();
			const owner = listeners
				.map((entry) => owners.get(entry.inode))
				.find((found) => found !== undefined);
			const container = containers.find((entry) => entry.ports.includes(port));
			services.push({
				port,
				addresses,
				protocolHint: HTTP_PORTS.has(port) ? "http" : "unknown",
				...(owner ? { process: { pid: owner.pid, command: owner.command } } : {}),
				...(container ? { container: { id: container.id, name: container.name } } : {}),
				previewReachability: this.reachability(addresses, forwarded.has(port)),
				observedAt,
			});
		}
		services.sort((left, right) => left.port - right.port);
		return services;
	}

	private reachability(
		addresses: string[],
		hasForward: boolean,
	): AgentListeningService["previewReachability"] {
		if (
			addresses.some(
				(address) =>
					isWildcard(address) ||
					(this.interfaceAddress !== null && address === this.interfaceAddress),
			)
		) {
			return "reachable";
		}
		if (hasForward) return "forwarded";
		// "denied" is the control plane's word, never the agent's.
		return "unknown";
	}

	private async readProcFile(name: string): Promise<string> {
		try {
			return await readFile(join(this.procRoot, name), "utf8");
		} catch {
			// One address family may be absent; the other still counts.
			return "";
		}
	}

	private async containers(): Promise<DockerContainer[]> {
		if (this.docker === null) return [];
		const now = Date.now();
		if (this.dockerCache && now - this.dockerCache.at < DOCKER_CACHE_MS) {
			return this.dockerCache.containers;
		}
		try {
			const containers = await this.docker();
			this.dockerCache = { at: now, containers };
			return containers;
		} catch {
			// No Docker, no socket, or too slow: discovery carries on without it.
			this.dockerCache = { at: now, containers: [] };
			return [];
		}
	}
}
