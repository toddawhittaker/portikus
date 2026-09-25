/**
 * The terminals of one project (SPEC.md §9.3, §9.6). Ended terminals stay in
 * the list so the user can start a new one in their place (SPEC.md §6.8,
 * §9.7). The server decides the working directory from the project
 * (SPEC.md §9.4), so nothing here sends a cwd.
 */
import {
	type CodingAgent,
	MAX_TERMINALS_PER_WORKSPACE,
	Terminal,
	TerminalList,
	type TerminalTheme,
} from "@portikus/contracts";
import { useToast } from "@portikus/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { z } from "zod";
import { ApiError, request, SessionEndedError } from "./api/request.js";

const JSON_HEADERS = { "content-type": "application/json" };

/** How often an idle tab re-reads the list, so a second browser's terminal shows up. */
const REFETCH_MS = 15_000;

export interface Terminals {
	terminals: Terminal[];
	loaded: boolean;
	error: string | null;
	create: (init?: { name?: string; agent?: CodingAgent }) => Promise<Terminal>;
	rename: (terminalId: string, name: string) => Promise<void>;
	/** Switch one terminal between the light and dark scheme (issue #268). */
	setTheme: (terminalId: string, theme: TerminalTheme) => Promise<void>;
	close: (terminalId: string) => Promise<void>;
	refetch: () => void;
}

/** What to tell the user when a terminal call fails (issue #474). */
export function terminalFailureMessage(error: unknown): string {
	if (error instanceof ApiError && error.code === "TERMINAL_LIMIT") {
		return `You can have up to ${MAX_TERMINALS_PER_WORKSPACE} terminals open at once. Close one to open another.`;
	}
	return "Something went wrong with the terminal. Please try again.";
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
	const toast = useToast();
	const key = terminalsKey(workspaceId, projectId);
	const url = `/workspaces/${workspaceId}/terminals`;

	const query = useQuery({
		queryKey: key,
		enabled: running,
		refetchInterval: running ? REFETCH_MS : false,
		queryFn: () =>
			request(TerminalList, `${url}?projectId=${encodeURIComponent(projectId)}`),
	});

	// A failed create, rename, theme change or close is a toast; the panes
	// behind it are still fine. An ended session is handled below instead.
	function showFailure(error: unknown) {
		if (error instanceof SessionEndedError) return;
		toast.show({ tone: "danger", title: terminalFailureMessage(error) });
	}

	async function invalidate() {
		await queryClient.invalidateQueries({ queryKey: key });
	}

	const create = useMutation({
		mutationFn: (init?: { name?: string; agent?: CodingAgent }) =>
			// The API answers with the created terminal. A launcher sends the
			// agent enum and no command string (SPEC.md §10.2).
			request(Terminal, url, {
				method: "POST",
				headers: JSON_HEADERS,
				body: JSON.stringify({
					projectId,
					...(init?.name ? { name: init.name } : {}),
					...(init?.agent ? { agent: init.agent } : {}),
				}),
			}),
		// No refetch here on purpose: a list answer holding a terminal the caller
		// has not placed yet would be reconciled into a tab of its own. The
		// caller places the terminal first and then calls refetch.
		//
		// The new terminal goes straight into the cache instead, so a poll that
		// was already in flight cannot answer without it and strip its pane.
		onSuccess: async (terminal) => {
			// A poll already on its way would otherwise land after this write.
			await queryClient.cancelQueries({ queryKey: key });
			queryClient.setQueryData<TerminalList>(key, (current) => {
				if (!current) return { terminals: [terminal] };
				if (current.terminals.some((item) => item.id === terminal.id)) return current;
				return { terminals: [...current.terminals, terminal] };
			});
		},
		onError: showFailure,
	});

	const rename = useMutation({
		mutationFn: ({ terminalId, name }: { terminalId: string; name: string }) =>
			request(Terminal, `${url}/${terminalId}`, {
				method: "PATCH",
				headers: JSON_HEADERS,
				body: JSON.stringify({ name }),
			}),
		onSuccess: invalidate,
		onError: showFailure,
	});

	const setTheme = useMutation({
		mutationFn: ({ terminalId, theme }: { terminalId: string; theme: TerminalTheme }) =>
			request(Terminal, `${url}/${terminalId}`, {
				method: "PATCH",
				headers: JSON_HEADERS,
				body: JSON.stringify({ theme }),
			}),
		// The pane repaints from the cached row, so write it back at once
		// rather than waiting for the next list answer.
		onSuccess: (terminal) => {
			queryClient.setQueryData<TerminalList>(key, (current) =>
				current
					? {
							terminals: current.terminals.map((item) =>
								item.id === terminal.id ? terminal : item,
							),
						}
					: current,
			);
		},
		onError: showFailure,
	});

	const close = useMutation({
		mutationFn: (terminalId: string) =>
			request(z.unknown(), `${url}/${terminalId}`, {
				method: "DELETE",
			}),
		onSuccess: invalidate,
		onError: showFailure,
	});

	// Any 401 means the session is gone, whichever call saw it first.
	const failure =
		query.error ??
		create.error ??
		rename.error ??
		setTheme.error ??
		close.error ??
		null;
	useEffect(() => {
		if (failure instanceof SessionEndedError) onSessionEnded();
	}, [failure, onSessionEnded]);

	return {
		terminals: query.data?.terminals ?? [],
		loaded: query.isSuccess,
		// Only a list that will not load keeps an inline line: then there is
		// nothing else to show.
		error:
			query.error && !(query.error instanceof SessionEndedError)
				? "Terminals are unavailable right now."
				: null,
		create: (init) => create.mutateAsync(init),
		rename: async (terminalId, name) => {
			await rename.mutateAsync({ terminalId, name });
		},
		setTheme: async (terminalId, theme) => {
			await setTheme.mutateAsync({ terminalId, theme });
		},
		close: async (terminalId) => {
			await close.mutateAsync(terminalId);
		},
		refetch: () => {
			void invalidate();
		},
	};
}
