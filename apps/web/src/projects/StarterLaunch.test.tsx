import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { json, project, renderApp, stubFetch, USER, WORKSPACE } from "../test-utils.js";
import {
	STARTER_ARCHIVED,
	STARTER_CREATED,
	STARTER_EXPIRED,
	STARTER_OPENED,
} from "./StarterLaunch.js";

const STARTER = "55555555-5555-4555-8555-555555555555";

/** A socket the test opens, then feeds one workspace frame. */
class PushSocket {
	static readonly OPEN = 1;
	static last: PushSocket | null = null;
	readyState = 0;
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;
	onclose: ((event: { code: number }) => void) | null = null;
	constructor(public url: string) {
		PushSocket.last = this;
	}
	send() {}
	close() {
		this.readyState = 3;
	}
}

afterEach(() => vi.unstubAllGlobals());

/** A running workspace whose starter route answers with `starter`. */
function stub(starter: () => Response) {
	PushSocket.last = null;
	vi.stubGlobal("WebSocket", PushSocket);
	const calls: string[] = [];
	const mock = stubFetch((url, init) => {
		if (url === "/auth/me") return json(200, USER);
		if (url === "/workspaces/mine" || url === `/workspaces/${WORKSPACE.id}`)
			return json(200, WORKSPACE);
		if (url.endsWith("/projects/starter") && init?.method === "POST") {
			calls.push(String(init.body));
			return starter();
		}
		if (url.includes("/projects?state=")) return json(200, { projects: [project()] });
		return json(404, { code: "NOT_FOUND", message: "Not here." });
	});
	return { calls, mock };
}

async function landing() {
	const { router } = renderApp(`/workspaces/${WORKSPACE.id}?starter=${STARTER}`);
	await waitFor(() => expect(PushSocket.last).not.toBeNull());
	const socket = PushSocket.last as PushSocket;
	act(() => {
		socket.readyState = 1;
		socket.onopen?.();
		socket.onmessage?.({
			data: JSON.stringify({ type: "workspace", workspace: WORKSPACE }),
		});
	});
	return router;
}

test("a new starter is created once, opened, and leaves the address", async () => {
	const { calls } = stub(() => json(200, { project: project(), created: true }));
	const router = await landing();

	expect(await screen.findByText(STARTER_CREATED)).toBeDefined();
	await waitFor(() =>
		expect(router.state.location.pathname).toBe(
			`/workspaces/${WORKSPACE.id}/projects/${project().id}`,
		),
	);
	expect(router.state.location.search).not.toHaveProperty("starter");
	expect(calls).toEqual([JSON.stringify({ starterId: STARTER })]);
});

test("an existing project is opened and says so", async () => {
	stub(() => json(200, { project: project(), created: false }));
	await landing();
	expect(await screen.findByText(STARTER_OPENED)).toBeDefined();
});

test("an archived project is not opened", async () => {
	stub(() =>
		json(200, {
			project: project({ state: "archived", archivedAt: "2026-01-02T00:00:00.000Z" }),
			created: false,
		}),
	);
	const router = await landing();
	expect((await screen.findAllByText(STARTER_ARCHIVED)).length).toBeGreaterThan(0);
	// The project index may open the one active project; only the starter must be gone.
	await waitFor(() => expect(router.state.location.search).toEqual({}));
});

test("an expired or unknown id shows the toast", async () => {
	stub(() => json(404, { code: "NOT_FOUND", message: "Not found." }));
	const router = await landing();
	expect(await screen.findByText(STARTER_EXPIRED)).toBeDefined();
	await waitFor(() => expect(router.state.location.search).toEqual({}));
});
