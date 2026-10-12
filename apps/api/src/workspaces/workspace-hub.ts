import type { ServerMessage } from "@portikus/events";

/** The part of a socket the hub needs; tests pass a stand-in. */
export interface HubSocket {
	readonly readyState: number;
	readonly OPEN: number;
	send(data: string): void;
}

/**
 * The owner's open workspace sockets, so a layout save can tell the owner's
 * other browsers (SPEC.md §7.5). Administrator sockets are never added, so
 * announcements reach the owner only (SPEC.md §24).
 */
export interface WorkspaceHub {
	/** Adds an owner socket; the returned function removes it. */
	add(workspaceId: string, socket: HubSocket): () => void;
	announceLayout(workspaceId: string, projectId: string, version: number): void;
}

export function layoutMessage(projectId: string, version: number): string {
	const message: ServerMessage = { type: "layout", projectId, version };
	return JSON.stringify(message);
}

export function createWorkspaceHub(): WorkspaceHub {
	const sockets = new Map<string, Set<HubSocket>>();

	return {
		add(workspaceId, socket) {
			let set = sockets.get(workspaceId);
			if (!set) {
				set = new Set();
				sockets.set(workspaceId, set);
			}
			set.add(socket);
			return () => {
				const current = sockets.get(workspaceId);
				if (!current) return;
				current.delete(socket);
				if (current.size === 0) sockets.delete(workspaceId);
			};
		},
		announceLayout(workspaceId, projectId, version) {
			const text = layoutMessage(projectId, version);
			for (const socket of sockets.get(workspaceId) ?? []) {
				if (socket.readyState === socket.OPEN) socket.send(text);
			}
		},
	};
}
