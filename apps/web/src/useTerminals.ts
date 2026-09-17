/**
 * The terminals of one project (SPEC.md §9.3, §9.6). Ended terminals stay in
 * the list so the user can start a new one in their place (SPEC.md §6.8,
 * §9.7). The server decides the working directory from the project
 * (SPEC.md §9.4), so nothing here sends a cwd.
 */
import { Terminal, TerminalList } from "@portikus/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { z } from "zod";
import { request, SessionEndedError } from "./api/request.js";

const JSON_HEADERS = { "content-type": "application/json" };

/** How often an idle tab re-reads the list, so a second browser's terminal shows up. */
const REFETCH_MS = 15_000;

export interface Terminals {
	terminals: Terminal[];
	loaded: boolean;
	error: string | null;
	create: (init?: { name?: string }) => Promise<Terminal>;
	rename: (terminalId: string, name: string) => Promise<void>;
	close: (terminalId: string) => Promise<void>;
	refetch: () => void;
}

export function terminalsKey(workspaceId: string, projectId: string) {
	return ["terminals", workspaceId, projectId] as const;
}

export function useTerminals(
	workspaceId: string,
	projectId: string,
	running: boolean,
	onSessionEnded: () => void,
): Terminals {
	const queryClient = useQueryClient();
	const key = terminalsKey(workspaceId, projectId);
	const url = `/workspaces/${workspaceId}/terminals`;

	const query = useQuery({
		queryKey: key,
		enabled: running,
		refetchInterval: running ? REFETCH_MS : false,
		refetchOnWindowFocus: true,
		queryFn: () =>
			request(TerminalList, `${url}?projectId=${encodeURIComponent(projectId)}`),
	});

	async function invalidate() {
		await queryClient.invalidateQueries({ queryKey: key });
	}

	const create = useMutation({
		mutationFn: (init?: { name?: string }) =>
			// The API answers with the created terminal.
			request(Terminal, url, {
				method: "POST",
				headers: JSON_HEADERS,
				body: JSON.stringify({ projectId, ...(init?.name ? { name: init.name } : {}) }),
			}),
		onSuccess: invalidate,
	});

	const rename = useMutation({
		mutationFn: ({ terminalId, name }: { terminalId: string; name: string }) =>
			request(Terminal, `${url}/${terminalId}`, {
				method: "PATCH",
				headers: JSON_HEADERS,
				body: JSON.stringify({ name }),
			}),
		onSuccess: invalidate,
	});

	const close = useMutation({
		mutationFn: (terminalId: string) =>
			request(z.unknown(), `${url}/${terminalId}`, {
				method: "DELETE",
			}),
		onSuccess: invalidate,
	});

	// Any 401 means the session is gone, whichever call saw it first.
	const failure = query.error ?? create.error ?? rename.error ?? close.error ?? null;
	useEffect(() => {
		if (failure instanceof SessionEndedError) onSessionEnded();
	}, [failure, onSessionEnded]);

	return {
		terminals: query.data?.terminals ?? [],
		loaded: query.isSuccess,
		error:
			failure && !(failure instanceof SessionEndedError)
				? "Terminals are unavailable right now."
				: null,
		create: (init) => create.mutateAsync(init),
		rename: async (terminalId, name) => {
			await rename.mutateAsync({ terminalId, name });
		},
		close: async (terminalId) => {
			await close.mutateAsync(terminalId);
		},
		refetch: () => {
			void invalidate();
		},
	};
}
