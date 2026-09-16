import type { Workspace } from "@portikus/contracts";
import { useEffect, useRef, useState } from "react";

const HEARTBEAT_MS = 15_000;
const RECONNECT_MS = 3_000;
const MAX_RECONNECT_MS = 60_000;
/** The API closes with this code when the session is gone (plan, package C). */
const SESSION_ENDED_CODE = 4401;

function socketUrl(workspaceId: string): string {
	const scheme = location.protocol === "https:" ? "wss" : "ws";
	return `${scheme}://${location.host}/workspaces/${workspaceId}/ws`;
}

/**
 * Once signed in, makes sure the user has a workspace and keeps a WebSocket
 * open to it. The last `workspace` message the server sent is returned.
 */
export function useWorkspaceSocket(
	enabled: boolean,
	onSessionEnded: () => void,
): Workspace | null {
	const [workspace, setWorkspace] = useState<Workspace | null>(null);
	const sessionEnded = useRef(onSessionEnded);
	sessionEnded.current = onSessionEnded;

	useEffect(() => {
		if (!enabled) {
			setWorkspace(null);
			return;
		}

		let stopped = false;
		let socket: WebSocket | null = null;
		let heartbeat: ReturnType<typeof setInterval> | undefined;
		let retry: ReturnType<typeof setTimeout> | undefined;
		let backoffMs = RECONNECT_MS;

		function connect(workspaceId: string) {
			if (stopped) return;
			const next = new WebSocket(socketUrl(workspaceId));
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
							retry = setTimeout(() => connect(workspaceId), wait);
						})
						.catch(() => {
							if (!stopped) retry = setTimeout(() => connect(workspaceId), wait);
						});
					return;
				}
				retry = setTimeout(() => connect(workspaceId), RECONNECT_MS);
			};
		}

		// `POST /workspaces` is idempotent: it returns the user's workspace.
		fetch("/workspaces", {
			method: "POST",
			credentials: "same-origin",
			headers: { "content-type": "application/json" },
			body: "{}",
		})
			.then(async (response) => {
				if (response.status === 401) {
					sessionEnded.current();
					return;
				}
				if (!response.ok) return;
				const created = (await response.json()) as Workspace;
				setWorkspace(created);
				connect(created.id);
			})
			.catch(() => {
				// Nothing to show; the next sign-in or reload tries again.
			});

		return () => {
			stopped = true;
			if (heartbeat !== undefined) clearInterval(heartbeat);
			if (retry !== undefined) clearTimeout(retry);
			socket?.close();
		};
	}, [enabled]);

	return workspace;
}
