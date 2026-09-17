import type { Terminal } from "@portikus/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

const JSON_HEADERS = { "content-type": "application/json" };

/**
 * The terminal list for one workspace (SPEC.md §9.3, §9.6). Ended terminals
 * stay in the list so the user can start a new one in their place
 * (SPEC.md §6.8, §9.7).
 */
export interface Terminals {
	terminals: Terminal[];
	error: string | null;
	create: (init?: { name?: string; cwd?: string }) => Promise<Terminal | null>;
	rename: (terminalId: string, name: string) => Promise<void>;
	close: (terminalId: string) => Promise<void>;
	markEnded: (terminalId: string) => void;
}

export function useTerminals(
	workspaceId: string | null,
	running: boolean,
	onSessionEnded: () => void,
): Terminals {
	const [terminals, setTerminals] = useState<Terminal[]>([]);
	const [error, setError] = useState<string | null>(null);
	const sessionEnded = useRef(onSessionEnded);
	sessionEnded.current = onSessionEnded;

	const request = useCallback(
		async (path: string, init?: RequestInit): Promise<Response | null> => {
			try {
				const response = await fetch(path, { credentials: "same-origin", ...init });
				if (response.status === 401) {
					sessionEnded.current();
					return null;
				}
				if (!response.ok) {
					setError("Terminals are unavailable right now.");
					return null;
				}
				setError(null);
				return response;
			} catch {
				setError("Terminals are unavailable right now.");
				return null;
			}
		},
		[],
	);

	const refresh = useCallback(async () => {
		if (!workspaceId) return;
		const response = await request(`/workspaces/${workspaceId}/terminals`);
		if (!response) return;
		const body = (await response.json()) as { terminals: Terminal[] };
		setTerminals(body.terminals);
	}, [request, workspaceId]);

	// List on mount, and again each time the workspace starts running.
	useEffect(() => {
		if (!workspaceId || !running) return;
		void refresh();
	}, [refresh, workspaceId, running]);

	const create = useCallback(
		async (init?: { name?: string; cwd?: string }) => {
			if (!workspaceId) return null;
			const response = await request(`/workspaces/${workspaceId}/terminals`, {
				method: "POST",
				headers: JSON_HEADERS,
				body: JSON.stringify(init ?? {}),
			});
			if (!response) return null;
			const created = (await response.json()) as Terminal;
			setTerminals((current) => [...current, created]);
			return created;
		},
		[request, workspaceId],
	);

	const rename = useCallback(
		async (terminalId: string, name: string) => {
			if (!workspaceId) return;
			const response = await request(
				`/workspaces/${workspaceId}/terminals/${terminalId}`,
				{ method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ name }) },
			);
			if (!response) return;
			const updated = (await response.json()) as Terminal;
			setTerminals((current) =>
				current.map((item) => (item.id === updated.id ? updated : item)),
			);
		},
		[request, workspaceId],
	);

	const close = useCallback(
		async (terminalId: string) => {
			if (!workspaceId) return;
			const response = await request(
				`/workspaces/${workspaceId}/terminals/${terminalId}`,
				{ method: "DELETE" },
			);
			if (!response) return;
			// The server decides whether a closed terminal disappears or is
			// kept as ended, so re-read the list rather than guessing.
			await refresh();
		},
		[refresh, request, workspaceId],
	);

	const markEnded = useCallback((terminalId: string) => {
		setTerminals((current) =>
			current.map((item) =>
				item.id === terminalId && item.endedAt === null
					? { ...item, endedAt: new Date().toISOString() }
					: item,
			),
		);
	}, []);

	return { terminals, error, create, rename, close, markEnded };
}
