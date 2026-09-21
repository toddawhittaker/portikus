import type { ApiConfig } from "@portikus/config";
import {
	type AgentListeningService,
	AgentListeningServicesChanged,
	type ListeningService,
} from "@portikus/contracts";
import type { Database } from "@portikus/db";
import type { Logger } from "@portikus/observability";
import type { Kysely } from "kysely";
import WebSocketClient, { type RawData } from "ws";
import { type AgentClient, agentClientFor } from "../agent-client.js";
import { portAllowed } from "./policy.js";
import { revokeWorkspacePreviewSessions } from "./store.js";

/** How often the registry looks for workspaces that started or stopped. */
const POLL_INTERVAL_MS = 2000;

/** The shortest and longest wait before reconnecting to an agent. */
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

/**
 * The largest frame the control plane accepts from an agent. The agent runs
 * inside the student's container, so its output is untrusted (SPEC.md §24.1).
 */
const MAX_AGENT_FRAME_BYTES = 1024 * 1024;

/** How long the agent has to answer the upgrade. */
const HANDSHAKE_TIMEOUT_MS = 5000;

interface Entry {
	client: AgentClient;
	address: string;
	socket: WebSocketClient | null;
	timer: NodeJS.Timeout | null;
	attempts: number;
	services: ListeningService[];
	/** True once the entry has been dropped, so a late callback does nothing. */
	closed: boolean;
}

export type ListeningListener = (services: ListeningService[]) => void;

/**
 * The control plane's view of what is listening inside every running
 * workspace (BROWSER-HANDLING.md §11.1, §17). One websocket per running
 * workspace; the list is kept in memory and is the only thing the preview
 * authorization endpoint consults for reachability, so nothing a request
 * carries can name an upstream.
 */
export interface ListeningRegistry {
	/** The latest list for a workspace, already stamped and policy-marked. */
	services(workspaceId: string): ListeningService[];
	/** One service by port, or undefined when nothing is listening on it. */
	service(workspaceId: string, port: number): ListeningService | undefined;
	/** Called on every change for one workspace; returns an unsubscribe. */
	subscribe(workspaceId: string, listener: ListeningListener): () => void;
	/**
	 * Make sure the preview gateway can reach a port: nothing to do when it is
	 * already reachable or forwarded, otherwise ask the agent for a loopback
	 * forward. Throws the agent's error when the forward cannot be opened.
	 */
	ensureReachable(workspaceId: string, port: number): Promise<void>;
	/** Close a loopback forward this workspace no longer needs. */
	closeForward(workspaceId: string, port: number): Promise<void>;
	/** Start polling. Safe to call twice. */
	start(): void;
	/** Stop polling and drop every agent socket. */
	stop(): Promise<void>;
}

export interface RegistryDeps {
	db: Kysely<Database>;
	config: ApiConfig;
	logger: Logger;
	/** Tests poll faster than production. */
	pollIntervalMs?: number;
}

export function createListeningRegistry(deps: RegistryDeps): ListeningRegistry {
	const { db, config, logger } = deps;
	const pollIntervalMs = deps.pollIntervalMs ?? POLL_INTERVAL_MS;
	const entries = new Map<string, Entry>();
	const listeners = new Map<string, Set<ListeningListener>>();
	let poller: NodeJS.Timeout | null = null;
	let stopped = false;
	const pending = new Set<Promise<unknown>>();

	function track(work: Promise<unknown>): void {
		pending.add(work);
		void work.finally(() => pending.delete(work));
	}

	/**
	 * Stamp the workspace id the agent never knows, and overwrite the
	 * reachability of any port policy refuses: "denied" is the control
	 * plane's word, never the agent's (BROWSER-HANDLING.md §11.1).
	 */
	function stamp(
		workspaceId: string,
		services: AgentListeningService[],
	): ListeningService[] {
		return services.map((service) => ({
			...service,
			workspaceId,
			previewReachability: portAllowed(config, service.port)
				? service.previewReachability
				: "denied",
		}));
	}

	function notify(workspaceId: string, services: ListeningService[]): void {
		for (const listener of listeners.get(workspaceId) ?? []) {
			try {
				listener(services);
			} catch (error) {
				logger.error({ err: error, workspaceId }, "listening listener failed");
			}
		}
	}

	function connect(workspaceId: string, entry: Entry): void {
		if (stopped || entry.closed) return;
		const socket = new WebSocketClient(entry.client.listeningEventsUrl(), {
			headers: { authorization: entry.client.authHeader() },
			handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
			maxPayload: MAX_AGENT_FRAME_BYTES,
		});
		entry.socket = socket;

		socket.on("open", () => {
			entry.attempts = 0;
		});

		socket.on("message", (raw: RawData) => {
			let parsed: unknown;
			try {
				parsed = JSON.parse(raw.toString());
			} catch {
				return; // A malformed frame from the container is ignored.
			}
			const frame = AgentListeningServicesChanged.safeParse(parsed);
			if (!frame.success) return;
			entry.services = stamp(workspaceId, frame.data.services);
			notify(workspaceId, entry.services);
		});

		socket.on("error", () => {
			// The close handler schedules the retry; an agent that is starting
			// up refuses connections, which is normal and not worth a log line.
		});

		socket.on("close", () => {
			if (entry.closed || stopped) return;
			entry.socket = null;
			entry.attempts += 1;
			const wait = Math.min(
				RECONNECT_MIN_MS * 2 ** (entry.attempts - 1),
				RECONNECT_MAX_MS,
			);
			const timer = setTimeout(() => connect(workspaceId, entry), wait);
			timer.unref?.();
			entry.timer = timer;
		});
	}

	function drop(workspaceId: string, options: { revoke: boolean }): void {
		const entry = entries.get(workspaceId);
		if (!entry) return;
		entry.closed = true;
		if (entry.timer) clearTimeout(entry.timer);
		entry.socket?.close();
		entries.delete(workspaceId);
		// A stopped workspace has nothing listening, and the UI must be told.
		notify(workspaceId, []);
		// A preview must stop working the moment its workspace leaves running
		// (BROWSER-HANDLING.md §9.2). A shutdown is not that: the sessions
		// outlive this process.
		if (!options.revoke) return;
		track(
			revokeWorkspacePreviewSessions(db, workspaceId).catch((error) => {
				logger.error({ err: error, workspaceId }, "preview revocation failed");
			}),
		);
	}

	/** True while a poll is running, so two never overlap. */
	let polling = false;

	async function poll(): Promise<void> {
		// A slow poll must not be joined by the next tick: two at once would
		// each make an entry for the same workspace and orphan a socket.
		if (polling) return;
		polling = true;
		try {
			await pollOnce();
		} finally {
			polling = false;
		}
	}

	async function pollOnce(): Promise<void> {
		const rows = await db
			.selectFrom("workspaces")
			.select(["id", "state", "agent_address", "agent_token"])
			.where("state", "=", "running")
			.execute();

		const running = new Set<string>();
		for (const row of rows) {
			const client = agentClientFor(
				row as unknown as Record<string, unknown>,
				config.AGENT_PORT,
			);
			if (!client) continue;
			running.add(row.id);
			const existing = entries.get(row.id);
			// A restarted workspace can come back on another address.
			if (existing && existing.address === row.agent_address) continue;
			if (existing) drop(row.id, { revoke: false });
			const entry: Entry = {
				client,
				address: row.agent_address ?? "",
				socket: null,
				timer: null,
				attempts: 0,
				services: [],
				closed: false,
			};
			entries.set(row.id, entry);
			connect(row.id, entry);
		}

		for (const workspaceId of [...entries.keys()]) {
			if (!running.has(workspaceId)) drop(workspaceId, { revoke: true });
		}
	}

	return {
		services(workspaceId) {
			return entries.get(workspaceId)?.services ?? [];
		},

		service(workspaceId, port) {
			return entries.get(workspaceId)?.services.find((one) => one.port === port);
		},

		subscribe(workspaceId, listener) {
			const set = listeners.get(workspaceId) ?? new Set<ListeningListener>();
			set.add(listener);
			listeners.set(workspaceId, set);
			return () => {
				set.delete(listener);
				if (set.size === 0) listeners.delete(workspaceId);
			};
		},

		async ensureReachable(workspaceId, port) {
			const entry = entries.get(workspaceId);
			if (!entry) throw new Error("workspace has no agent connection");
			const service = entry.services.find((one) => one.port === port);
			if (
				service?.previewReachability === "reachable" ||
				service?.previewReachability === "forwarded"
			) {
				return;
			}
			const forward = await entry.client.openForward(port);
			// The agent's own report follows on the events socket; record the
			// forward now so a grant issued in the same second is consistent.
			entry.services = entry.services.map((one) =>
				one.port === port && forward.state === "open"
					? { ...one, previewReachability: "forwarded" }
					: one,
			);
		},

		async closeForward(workspaceId, port) {
			const entry = entries.get(workspaceId);
			if (!entry) return;
			await entry.client.closeForward(port);
		},

		start() {
			if (poller !== null || stopped) return;
			const timer = setInterval(() => {
				track(
					poll().catch((error) => {
						logger.error({ err: error }, "listening registry poll failed");
					}),
				);
			}, pollIntervalMs);
			timer.unref?.();
			poller = timer;
			track(
				poll().catch((error) => {
					logger.error({ err: error }, "listening registry poll failed");
				}),
			);
		},

		async stop() {
			stopped = true;
			if (poller) clearInterval(poller);
			poller = null;
			for (const workspaceId of [...entries.keys()]) {
				drop(workspaceId, { revoke: false });
			}
			listeners.clear();
			while (pending.size > 0) await Promise.allSettled([...pending]);
		},
	};
}
