import type { Logger } from "@portikus/observability";
import type { ListeningRegistry } from "./registry.js";

/**
 * The same-origin port bridge (BROWSER-HANDLING.md §14, pattern 2). A page in
 * a preview may call `/__portikus/ports/8000/api/users` to reach another port
 * of the SAME workspace. Caddy reserves that path, keeps the original URI in
 * `X-Forwarded-Uri` for the authorization subrequest, and strips the prefix
 * before proxying.
 */
const BRIDGE_PREFIX = "/__portikus/ports/";

/** As strict as the preview host parser: digits only, no leading zero. */
const PORT_PATTERN = /^[1-9][0-9]{0,4}$/;

export type BridgeTarget =
	/** Not a bridge request; the preview session's own port applies. */
	| { kind: "none" }
	/** The reserved prefix with something that is not a plain port after it. */
	| { kind: "invalid" }
	| { kind: "port"; port: number };

/** What port, if any, an authorization subrequest's URI asks the bridge for. */
export function parseBridgeUri(uri: unknown): BridgeTarget {
	const value = Array.isArray(uri) ? uri[0] : uri;
	if (typeof value !== "string" || value === "") return { kind: "none" };
	const path = value.split("?")[0]?.split("#")[0] ?? "";
	if (!path.startsWith(BRIDGE_PREFIX)) return { kind: "none" };

	const rest = path.slice(BRIDGE_PREFIX.length);
	// The prefix is a directory: the port is always followed by a path.
	const slash = rest.indexOf("/");
	if (slash <= 0) return { kind: "invalid" };
	const text = rest.slice(0, slash);
	if (!PORT_PATTERN.test(text)) return { kind: "invalid" };
	const port = Number(text);
	if (!Number.isInteger(port) || port < 1 || port > 65535) return { kind: "invalid" };
	return { kind: "port", port };
}

/**
 * The loopback forwards the bridge opened, and when they close: a bridge
 * forward lives no longer than a grant's does (BROWSER-HANDLING.md §11.1), so
 * it closes when the port stops listening or the preview session ends.
 */
export interface BridgeForwards {
	/** Make a bridge port reachable, remembering it for this session. */
	ensure(workspaceId: string, sessionId: string, port: number): Promise<void>;
	/** Close the forwards one preview session opened. */
	closeForSession(sessionId: string): Promise<void>;
	/** Close every bridge forward of one workspace. */
	closeForWorkspace(workspaceId: string): Promise<void>;
}

interface Tracked {
	workspaceId: string;
	port: number;
	sessions: Set<string>;
}

export function createBridgeForwards(deps: {
	registry: ListeningRegistry;
	logger: Logger;
}): BridgeForwards {
	const { registry, logger } = deps;
	const tracked = new Map<string, Tracked>();
	const watchers = new Map<string, () => void>();

	const keyOf = (workspaceId: string, port: number) => `${workspaceId}|${port}`;

	async function close(entry: Tracked): Promise<void> {
		if (!tracked.delete(keyOf(entry.workspaceId, entry.port))) return;
		const stillWatched = [...tracked.values()].some(
			(one) => one.workspaceId === entry.workspaceId,
		);
		if (!stillWatched) {
			watchers.get(entry.workspaceId)?.();
			watchers.delete(entry.workspaceId);
		}
		await registry.closeForward(entry.workspaceId, entry.port).catch((error) => {
			logger.warn(
				{ err: error, workspaceId: entry.workspaceId, port: entry.port },
				"bridge forward could not be closed",
			);
		});
	}

	/** Watch a workspace so a port that stops listening loses its forward. */
	function watch(workspaceId: string): void {
		if (watchers.has(workspaceId)) return;
		const off = registry.subscribe(workspaceId, (services) => {
			for (const entry of [...tracked.values()]) {
				if (entry.workspaceId !== workspaceId) continue;
				const live = services.some(
					(one) => one.port === entry.port && one.previewReachability !== "denied",
				);
				if (!live) void close(entry);
			}
		});
		watchers.set(workspaceId, off);
	}

	return {
		async ensure(workspaceId, sessionId, port) {
			const before = registry.service(workspaceId, port);
			await registry.ensureReachable(workspaceId, port);
			const key = keyOf(workspaceId, port);
			const entry = tracked.get(key);
			if (entry) {
				// A forward the bridge already opened: this session is using it
				// too, so it must outlive whichever session ends first.
				entry.sessions.add(sessionId);
				return;
			}
			// A service already reachable needed no forward, so the bridge owns
			// nothing to close for it.
			if (before?.previewReachability !== "unknown") return;
			tracked.set(key, { workspaceId, port, sessions: new Set([sessionId]) });
			watch(workspaceId);
		},

		async closeForSession(sessionId) {
			for (const entry of [...tracked.values()]) {
				if (!entry.sessions.delete(sessionId)) continue;
				// Another live preview session may still be using this port.
				if (entry.sessions.size === 0) await close(entry);
			}
		},

		async closeForWorkspace(workspaceId) {
			for (const entry of [...tracked.values()]) {
				if (entry.workspaceId === workspaceId) await close(entry);
			}
		},
	};
}
