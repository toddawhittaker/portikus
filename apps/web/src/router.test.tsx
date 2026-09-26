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
	// Each page names the browser tab (issue #374).
	expect(document.title).toBe("Sign in, Portikus");
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

test("an administrator goes to the administration page and gets no workspace (issue #534)", async () => {
	const fetch = stubFetch((url, init) => {
		if (url === "/auth/me") return json(200, { ...USER, role: "administrator" });
		if (url === "/workspaces" && init?.method === "POST") return json(201, WORKSPACE);
		return json(200, {});
	});

	const { router } = renderApp("/");

	await waitFor(() => expect(router.state.location.pathname).toBe("/admin"));
	await screen.findByTestId("open-my-workspace-status");
	const posted = fetch.mock.calls.some(
		([url, init]) => url === "/workspaces" && init?.method === "POST",
	);
	expect(posted).toBe(false);
});

test("an instructor still goes to their workspace (issue #534)", async () => {
	stubFetch((url, init) => {
		if (url === "/auth/me") return json(200, { ...USER, role: "instructor" });
		if (url === "/workspaces" && init?.method === "POST") return json(201, WORKSPACE);
		if (url.endsWith("/templates")) return json(200, { templates: [] });
		if (url.includes("/projects")) return json(200, { projects: [project()] });
		return json(200, {});
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
	expect(document.title).toBe("Not authorized, Portikus");
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
	expect(document.title).toBe("Session ended, Portikus");
});

test("the files route hands over to the project screen with the file to open", async () => {
	// SPEC.md §14.9: a `path:line` link from a terminal lands in the editor.
	stubFetch((url) => {
		if (url === "/auth/me") return json(200, USER);
		if (url.endsWith("/templates")) return json(200, { templates: [] });
		if (url.includes("/projects")) return json(200, { projects: [project()] });
		throw new Error(`unexpected request: ${url}`);
	});
	vi.stubGlobal("WebSocket", FakeWebSocket);

	const { router } = renderApp(
		`/workspaces/${WORKSPACE.id}/projects/${project().id}/files?path=src/app.ts&line=3`,
	);

	await waitFor(() =>
		expect(router.state.location.pathname).toBe(
			`/workspaces/${WORKSPACE.id}/projects/${project().id}`,
		),
	);
	expect(router.state.location.search).toEqual({ open: "src/app.ts", line: 3 });
});

test("the project screen names the tab after the project (issue #374)", async () => {
	stubProject();

	renderApp(`/workspaces/${WORKSPACE.id}/projects/${project().id}`);

	await waitFor(() => expect(document.title).toBe("todo-api, Portikus"));
});

/** The stubs every link test needs: the user, the templates and the project. */
function stubProject() {
	stubFetch((url) => {
		if (url === "/auth/me") return json(200, USER);
		if (url.endsWith("/templates")) return json(200, { templates: [] });
		if (url.includes("/projects")) return json(200, { projects: [project()] });
		throw new Error(`unexpected request: ${url}`);
	});
	vi.stubGlobal("WebSocket", FakeWebSocket);
}

test("an open link that leaves the project opens nothing", async () => {
	// SPEC.md §14.9, §24.6: `?open=` is a project path or it is nothing.
	stubProject();

	const { router } = renderApp(
		`/workspaces/${WORKSPACE.id}/projects/${project().id}?open=../x`,
	);

	await waitFor(() => expect(router.state.matches.length).toBeGreaterThan(0));
	expect(router.state.matches.at(-1)?.search).toEqual({
		open: undefined,
		line: undefined,
	});
});

test("a line that is not a whole line number is ignored", async () => {
	stubProject();

	const { router } = renderApp(
		`/workspaces/${WORKSPACE.id}/projects/${project().id}?open=src/app.ts&line=3.7`,
	);

	await waitFor(() => expect(router.state.matches.length).toBeGreaterThan(0));
	expect(router.state.matches.at(-1)?.search).toEqual({
		open: "src/app.ts",
		line: undefined,
	});
});

test("the files route drops an unsafe path and a fractional line", async () => {
	stubProject();

	const { router } = renderApp(
		`/workspaces/${WORKSPACE.id}/projects/${project().id}/files?path=../etc/passwd&line=3.7`,
	);

	await waitFor(() =>
		expect(router.state.location.pathname).toBe(
			`/workspaces/${WORKSPACE.id}/projects/${project().id}`,
		),
	);
	expect(router.state.matches.at(-1)?.search).toEqual({
		open: undefined,
		line: undefined,
	});
});

test("the Logs tab's filters come from the URL, and unknown values are dropped (docs/EPIC-19.md ruling 32)", async () => {
	const requested: string[] = [];
	stubFetch((url) => {
		if (url === "/auth/me") return json(200, { ...USER, role: "administrator" });
		if (url.startsWith("/admin/logs")) {
			requested.push(url);
			return json(200, {
				lines: [],
				nextCursor: null,
				scanComplete: true,
				skippedLines: 0,
			});
		}
		return json(200, {});
	});
	const user = "11111111-2222-4333-8444-555555555555";

	const { router } = renderApp(
		`/admin?tab=logs&level=info,bogus,debug&service=worker&since=yesterday&until=2026-09-26T10:00:00.000Z&q=boom&user=${user}&workspace=not-a-uuid`,
	);

	await waitFor(() => expect(requested.length).toBeGreaterThan(0));
	expect(router.state.location.search).toMatchObject({
		tab: "logs",
		level: "info,debug",
		service: "worker",
		until: "2026-09-26T10:00:00.000Z",
		q: "boom",
		user,
	});
	expect(router.state.location.search).not.toHaveProperty("since", "yesterday");
	const params = new URLSearchParams(requested[0]?.split("?")[1]);
	expect(params.get("level")).toBe("info,debug");
	expect(params.get("service")).toBe("worker");
	expect(params.get("q")).toBe("boom");
	expect(params.get("user")).toBe(user);
	expect(params.has("workspace")).toBe(false);
});
