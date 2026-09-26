import { ToastProvider } from "@portikus/ui";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { render } from "@testing-library/react";
import type * as React from "react";
import { vi } from "vitest";
import { createQueryClient } from "./api/queryClient.js";
import { routeTree } from "./router.js";

export const USER = {
	id: "11111111-1111-4111-8111-111111111111",
	email: "alice@example.invalid",
	displayName: "Alice Example",
	role: "student" as const,
	mustChangePassword: false,
	mustAcceptUse: false,
	localPassword: false,
};

export const WORKSPACE = {
	id: "22222222-2222-4222-8222-222222222222",
	ownerUserId: USER.id,
	label: "tw7",
	state: "running" as const,
	desiredState: "running" as const,
	incusInstanceName: "ws-alice",
	imageVersion: "2026.09.3",
	quotaConfig: { homeGiB: 10, dockerGiB: 10 },
	pendingOperation: null,
	errorCode: null,
	errorMessage: null,
	activeConnections: 1,
	lastActiveConnectionAt: null,
	shutdownDeadline: null,
	archivedAt: null,
	cpuThrottle: null,
	idleStopAt: null,
	lastActivityAt: null,
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
};

export function project(overrides: Record<string, unknown> = {}) {
	return {
		id: "44444444-4444-4444-8444-444444444444",
		workspaceId: WORKSPACE.id,
		slug: "todo-api",
		name: "todo-api",
		path: "/home/student/projects/todo-api",
		state: "active" as const,
		source: "new" as const,
		isGitRepo: true,
		missing: false,
		createdAt: "2026-01-01T00:00:00.000Z",
		archivedAt: null,
		...overrides,
	};
}

export function json(status: number, body: unknown): Response {
	return new Response(status === 204 ? null : JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/** Answers each request by URL and method; anything unmatched is a test failure. */
export function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
	const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
		handler(String(input), init),
	);
	vi.stubGlobal("fetch", mock);
	return mock;
}

/** A WebSocket that never opens, for tests that do not care about presence. */
export class FakeWebSocket {
	static readonly OPEN = 1;
	readyState = 0;
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;
	onclose: ((event: { code: number }) => void) | null = null;
	static last: FakeWebSocket | null = null;
	/** Every socket made since the list was last cleared, oldest first. */
	static all: FakeWebSocket[] = [];

	constructor(public url: string) {
		FakeWebSocket.last = this;
		FakeWebSocket.all.push(this);
	}
	send() {}
	close() {
		this.readyState = 3;
	}
}

/** Renders the real route tree at `path` with a memory history. */
export function renderApp(path: string) {
	const router = createRouter({
		routeTree,
		history: createMemoryHistory({ initialEntries: [path] }),
	});
	const queryClient = createQueryClient(() => {
		void router.navigate({ to: "/session-ended" });
	});
	const { unmount } = render(
		<QueryClientProvider client={queryClient}>
			<ToastProvider>
				{/* biome-ignore lint/suspicious/noExplicitAny: the test router is not the registered one */}
				<RouterProvider router={router as any} />
			</ToastProvider>
		</QueryClientProvider>,
	);
	return { router, unmount };
}

/**
 * Renders one component with a QueryClient, for the dialogs. The client is
 * returned so a test can refetch the way the project events socket does.
 */
export function renderWithQuery(ui: React.ReactElement): QueryClient {
	const queryClient = createQueryClient(() => {});
	render(
		<QueryClientProvider client={queryClient}>
			<ToastProvider>{ui}</ToastProvider>
		</QueryClientProvider>,
	);
	return queryClient;
}
