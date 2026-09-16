import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Home } from "./Home";

const user = {
	id: "11111111-1111-4111-8111-111111111111",
	email: "alice@example.invalid",
	displayName: "Alice Example",
	role: "student",
};

const workspace = {
	id: "22222222-2222-4222-8222-222222222222",
	ownerUserId: user.id,
	state: "running",
	desiredState: "running",
	incusInstanceName: "ws-alice",
	imageVersion: null,
	quotaConfig: { homeGiB: 10, dockerGiB: 10 },
	errorCode: null,
	errorMessage: null,
	activeConnections: 1,
	lastActiveConnectionAt: null,
	shutdownDeadline: null,
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
};

function json(status: number, body: unknown): Response {
	return {
		status,
		ok: status < 400,
		json: async () => body,
	} as Response;
}

/** Routes each request by URL so the page's three calls can differ. */
function stubFetch(me: Response) {
	const fetchMock = vi.fn(async (input: string) => {
		const url = String(input);
		if (url === "/health") return json(200, { status: "ok" });
		if (url === "/auth/me") return me;
		if (url === "/workspaces") return json(201, workspace);
		throw new Error(`unexpected request: ${url}`);
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

const sockets: FakeWebSocket[] = [];

class FakeWebSocket {
	static readonly OPEN = 1;
	readonly url: string;
	readyState = FakeWebSocket.OPEN;
	sent: string[] = [];
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;
	onclose: ((event: { code: number }) => void) | null = null;

	constructor(url: string) {
		this.url = url;
		sockets.push(this);
	}

	send(data: string) {
		this.sent.push(data);
	}

	close() {
		this.readyState = 3;
	}
}

afterEach(() => {
	cleanup();
	sockets.length = 0;
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

test("renders the product name and a sign-in link when nobody is signed in", async () => {
	stubFetch(json(401, {}));
	render(<Home />);

	expect(screen.getByRole("heading", { name: "Portikus" })).toBeDefined();
	const link = await screen.findByTestId("signin");
	expect(link.getAttribute("href")).toBe("/auth/login");
});

test("shows the signed-in user and a logout form", async () => {
	stubFetch(json(200, { user }));
	vi.stubGlobal("WebSocket", FakeWebSocket);
	render(<Home />);

	const me = await screen.findByTestId("me");
	expect(me.textContent).toBe("Signed in as Alice Example (student)");
	const form = screen.getByTestId("signout").closest("form");
	expect(form?.getAttribute("action")).toBe("/auth/logout");
	expect(form?.getAttribute("method")).toBe("post");
});

test("shows the workspace state from the socket and sends a heartbeat", async () => {
	// shouldAdvanceTime keeps waitFor working while the heartbeat timer is fake.
	vi.useFakeTimers({ shouldAdvanceTime: true });
	stubFetch(json(200, { user }));
	vi.stubGlobal("WebSocket", FakeWebSocket);
	render(<Home />);

	await waitFor(() => expect(sockets).toHaveLength(1));
	const socket = sockets[0] as FakeWebSocket;
	expect(socket.url).toContain(`/workspaces/${workspace.id}/ws`);

	act(() => {
		socket.onopen?.();
		socket.onmessage?.({
			data: JSON.stringify({
				type: "workspace",
				workspace: { ...workspace, state: "starting" },
			}),
		});
	});
	expect(screen.getByTestId("workspace-state").textContent).toBe("state: starting");

	act(() => {
		vi.advanceTimersByTime(15_000);
	});
	expect(socket.sent).toEqual([JSON.stringify({ type: "heartbeat" })]);
});
