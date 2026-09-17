import { screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import {
	FakeWebSocket,
	json,
	project,
	renderApp,
	stubFetch,
	USER,
	WORKSPACE,
} from "./test-utils.js";

afterEach(() => vi.unstubAllGlobals());

test("signed out, the front page offers the institution sign-in", async () => {
	stubFetch((url) => {
		if (url === "/auth/me") return json(401, { code: "UNAUTHORIZED", message: "no" });
		throw new Error(`unexpected request: ${url}`);
	});

	renderApp("/");

	const link = await screen.findByTestId("signin");
	expect(link.getAttribute("href")).toBe("/auth/login");
});

test("signed in, the front page goes to the student's workspace", async () => {
	stubFetch((url, init) => {
		if (url === "/auth/me") return json(200, USER);
		if (url === "/workspaces" && init?.method === "POST") return json(201, WORKSPACE);
		if (url.endsWith("/templates")) return json(200, { templates: [] });
		if (url.includes("/projects")) return json(200, { projects: [project()] });
		throw new Error(`unexpected request: ${url}`);
	});
	vi.stubGlobal("WebSocket", FakeWebSocket);

	const { router } = renderApp("/");

	await waitFor(() =>
		expect(router.state.location.pathname).toBe(`/workspaces/${WORKSPACE.id}`),
	);
});

test("an account without access lands on the not-authorized page", async () => {
	stubFetch((url) => {
		if (url === "/auth/me") {
			return json(403, {
				code: "FORBIDDEN",
				message: "Your account is not authorized to use Portikus",
			});
		}
		throw new Error(`unexpected request: ${url}`);
	});

	const { router } = renderApp("/");

	await waitFor(() => expect(router.state.location.pathname).toBe("/not-authorized"));
	expect(screen.getByTestId("page-not-authorized")).toBeDefined();
});

test("a 401 from a data request ends the session", async () => {
	stubFetch((url) => {
		if (url === "/auth/me") return json(200, USER);
		if (url.endsWith("/templates")) return json(200, { templates: [] });
		if (url.includes("/projects")) {
			return json(401, { code: "UNAUTHORIZED", message: "no session" });
		}
		throw new Error(`unexpected request: ${url}`);
	});
	vi.stubGlobal("WebSocket", FakeWebSocket);

	const { router } = renderApp(`/workspaces/${WORKSPACE.id}`);

	await waitFor(() => expect(router.state.location.pathname).toBe("/session-ended"));
	expect(screen.getByTestId("page-session-ended")).toBeDefined();
});
