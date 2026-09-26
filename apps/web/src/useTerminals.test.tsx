import type { Terminal, TerminalList } from "@portikus/contracts";
import { ToastProvider } from "@portikus/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { ApiError } from "./api/request";
import { terminalFailureMessage, terminalsKey, useTerminals } from "./useTerminals";

const WORKSPACE = "22222222-2222-4222-8222-222222222222";
const PROJECT = "33333333-3333-4333-8333-333333333333";

const created: Terminal = {
	id: "44444444-4444-4444-8444-444444444444",
	workspaceId: WORKSPACE,
	name: "zsh",
	cwd: "/home/student/projects/todo-api",
	position: 0,
	projectId: PROJECT,
	createdAt: "2026-01-01T00:00:00.000Z",
	theme: "dark",
	endedAt: null,
};

afterEach(() => {
	vi.unstubAllGlobals();
});

test("a created terminal is in the cached list before any refetch", async () => {
	// The list answer is always empty, standing in for a poll that was already
	// in flight when the terminal was created.
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_input: string, init?: RequestInit) => {
			if (init?.method === "POST") {
				return { status: 201, ok: true, json: async () => created } as Response;
			}
			return {
				status: 200,
				ok: true,
				json: async () => ({ terminals: [] }),
			} as Response;
		}),
	);
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>
			<ToastProvider>{children}</ToastProvider>
		</QueryClientProvider>
	);
	const { result } = renderHook(() => useTerminals(WORKSPACE, PROJECT, true, vi.fn()), {
		wrapper,
	});
	await waitFor(() => expect(result.current.loaded).toBe(true));

	await result.current.create();

	const cached = client.getQueryData<TerminalList>(terminalsKey(WORKSPACE, PROJECT));
	expect(cached?.terminals.map((terminal) => terminal.id)).toEqual([created.id]);
});

// Issue #474: the limit is named, anything else stays generic.
test("TERMINAL_LIMIT names the limit and other failures stay generic", () => {
	expect(terminalFailureMessage(new ApiError(409, "at most", "TERMINAL_LIMIT"))).toBe(
		"You can have up to 20 terminals open at once. Close one to open another.",
	);
	expect(terminalFailureMessage(new ApiError(502, "down", "AGENT_UNAVAILABLE"))).toBe(
		"Something went wrong with the terminal. Please try again.",
	);
	expect(terminalFailureMessage(new Error("network"))).toBe(
		"Something went wrong with the terminal. Please try again.",
	);
});

test("a refused create is a toast, not the inline error", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_input: string, init?: RequestInit) => {
			if (init?.method === "POST") {
				return {
					status: 409,
					ok: false,
					json: async () => ({
						code: "TERMINAL_LIMIT",
						message: "A workspace may have at most 20 terminals open.",
					}),
				} as Response;
			}
			return {
				status: 200,
				ok: true,
				json: async () => ({ terminals: [] }),
			} as Response;
		}),
	);
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>
			<ToastProvider>{children}</ToastProvider>
		</QueryClientProvider>
	);
	const { result } = renderHook(() => useTerminals(WORKSPACE, PROJECT, true, vi.fn()), {
		wrapper,
	});
	await waitFor(() => expect(result.current.loaded).toBe(true));

	await expect(result.current.create()).rejects.toThrow();

	expect(
		await screen.findByText(
			"You can have up to 20 terminals open at once. Close one to open another.",
		),
	).toBeTruthy();
	expect(result.current.error).toBeNull();
});
