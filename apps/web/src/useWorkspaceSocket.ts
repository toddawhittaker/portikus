import type { Workspace } from "@portikus/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { wsUrl } from "./api/ws.js";

const HEARTBEAT_MS = 15_000;
const RECONNECT_MS = 3_000;
const MAX_RECONNECT_MS = 60_000;
/** The API closes with this code when the session is gone (SPEC.md §26). */
const SESSION_ENDED_CODE = 4401;

function socketUrl(workspaceId: string): string {
	return wsUrl(`/workspaces/${workspaceId}/ws`);
}

export interface WorkspaceSocket {
	/** The last `workspace` message the server sent, or null before the first. */
	workspace: Workspace | null;
	/** Drop the socket and connect again now, without waiting for the backoff. */
	reconnect: () => void;
}

/**
 * Keeps a WebSocket open to one workspace. The connection is what the server
 * counts as presence (SPEC.md §6.4), so it stays open for as long as the
 * page is on a workspace screen.
 */
export function useWorkspaceSocket(
	workspaceId: string | null,
	onSessionEnded: () => void,
): WorkspaceSocket {
	const [workspace, setWorkspace] = useState<Workspace | null>(null);
	const [attempt, setAttempt] = useState(0);
	const sessionEnded = useRef(onSessionEnded);
	sessionEnded.current = onSessionEnded;

	const reconnect = useCallback(() => setAttempt((value) => value + 1), []);

	// `attempt` is never read in the body on purpose: bumping it is what
	// reconnect() does, and re-running the effect is how the socket is replaced.
	// biome-ignore lint/correctness/useExhaustiveDependencies: restart trigger
	useEffect(() => {
		if (!workspaceId) {
			setWorkspace(null);
			return;
		}

		let stopped = false;
		let socket: WebSocket | null = null;
		let heartbeat: ReturnType<typeof setInterval> | undefined;
		let retry: ReturnType<typeof setTimeout> | undefined;
		let backoffMs = RECONNECT_MS;

		function connect(id: string) {
			if (stopped) return;
			const next = new WebSocket(socketUrl(id));
			socket = next;
			let opened = false;

			next.onopen = () => {
				opened = true;
				backoffMs = RECONNECT_MS;
				heartbeat = setInterval(() => {
					if (next.readyState === WebSocket.OPEN) {
						next.send(JSON.stringify({ type: "heartbeat" }));
					}
				}, HEARTBEAT_MS);
			};

			next.onmessage = (event: MessageEvent) => {
				try {
					const message = JSON.parse(String(event.data)) as {
						type?: string;
						workspace?: Workspace;
					};
					if (message.type === "workspace" && message.workspace) {
						setWorkspace(message.workspace);
					}
				} catch {
					// Ignore anything that is not a message we understand.
				}
			};

			next.onclose = (event: CloseEvent) => {
				if (heartbeat !== undefined) clearInterval(heartbeat);
				if (stopped) return;
				if (event.code === SESSION_ENDED_CODE) {
					sessionEnded.current();
					return;
				}
				if (!opened) {
					// The upgrade was refused. Ask once whether we are still signed
					// in, then back off rather than hammering the server.
					const wait = backoffMs;
					backoffMs = Math.min(backoffMs * 2, MAX_RECONNECT_MS);
					void fetch("/auth/me", { credentials: "same-origin" })
						.then((response) => {
							if (stopped) return;
							if (response.status === 401) {
								sessionEnded.current();
								return;
							}
							retry = setTimeout(() => connect(id), wait);
						})
						.catch(() => {
							if (!stopped) retry = setTimeout(() => connect(id), wait);
						});
					return;
				}
				retry = setTimeout(() => connect(id), RECONNECT_MS);
			};
		}

		connect(workspaceId);

		return () => {
			stopped = true;
			if (heartbeat !== undefined) clearInterval(heartbeat);
			if (retry !== undefined) clearTimeout(retry);
			socket?.close();
		};
	}, [workspaceId, attempt]);

	return { workspace, reconnect };
}
