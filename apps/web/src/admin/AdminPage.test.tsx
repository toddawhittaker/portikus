import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import {
	FakeWebSocket,
	json,
	renderApp,
	stubFetch,
	USER,
	WORKSPACE,
} from "../test-utils.js";

afterEach(() => vi.unstubAllGlobals());

const ADMIN = {
	...USER,
	id: "33333333-3333-4333-8333-333333333333",
	displayName: "Carol Admin",
	email: "carol@example.invalid",
	role: "administrator" as const,
};

const STUDENT_ROW = {
	id: USER.id,
	displayName: USER.displayName,
	email: USER.email,
	role: "student" as const,
	providerRole: "student" as const,
	grantedRole: null,
	disabledAt: null,
	shutdownGraceSeconds: 30,
	dexLocal: false,
	preferredUsername: null,
	issuer: null,
	lastLoginAt: null,
	markers: {
		disabled: false,
		archived: false,
		duplicateEmail: false,
		stale: false,
		linked: false,
	},
	workspace: null,
};

const ADMIN_ROW = {
	id: ADMIN.id,
	displayName: ADMIN.displayName,
	email: ADMIN.email,
	role: "administrator" as const,
	providerRole: "administrator" as const,
	grantedRole: null,
	disabledAt: "2026-01-01T00:00:00.000Z",
	shutdownGraceSeconds: null,
	dexLocal: false,
	preferredUsername: null,
	issuer: null,
	lastLoginAt: null,
	markers: {
		disabled: true,
		archived: false,
		duplicateEmail: false,
		stale: false,
		linked: false,
	},
	workspace: null,
};

/** Answers the admin reads; `onWrite` sees every PUT body. */
function stubAdmin(
	graceSeconds: number,
	onWrite?: (url: string, body: unknown) => void,
) {
	return stubFetch((url, init) => {
		if (url === "/auth/me") return json(200, ADMIN);
		if (url === "/admin/settings" && init?.method === "PUT") {
			const body = JSON.parse(String(init.body));
			onWrite?.(url, body);
			return json(200, {
				shutdownGraceSeconds: body.shutdownGraceSeconds ?? graceSeconds,
				logLevel: body.logLevel ?? null,
				updatedAt: "2026-01-01T00:00:00.000Z",
			});
		}
		if (url === "/admin/settings") {
			return json(200, {
				shutdownGraceSeconds: graceSeconds,
				logLevel: null,
				updatedAt: null,
			});
		}
		if (url.startsWith("/admin/users/") && init?.method === "PUT") {
			const body = JSON.parse(String(init.body));
			onWrite?.(url, body);
			return json(200, { ...STUDENT_ROW, ...body });
		}
		if (url === "/admin/users") {
			return json(200, { users: [STUDENT_ROW, ADMIN_ROW], dexUsers: false });
		}
		throw new Error(`unexpected request: ${url}`);
	});
}

/** Opens one account's detail panel from the Workspaces tab. */
async function openDetail(name: string): Promise<void> {
	fireEvent.click(
		await screen.findByRole("button", {
			name: new RegExp(`^Show details for ${name}, `),
		}),
	);
	await screen.findByRole("region", { name });
}

test("the page opens on the Users tab and each tab is a link", async () => {
	stubAdmin(600);

	renderApp("/admin");

	const nav = await screen.findByRole("navigation", { name: "Administration" });
	const current = within(nav).getByRole("link", { current: "page" });
	// Relabelled Users; the address stays ?tab=workspaces (docs/archive/epics/EPIC-13-1.md ruling 24).
	expect(current.textContent).toBe("Users");
	expect(current.getAttribute("href")).toBe("/admin?tab=workspaces");
	expect(within(nav).getByRole("link", { name: "Settings" }).getAttribute("href")).toBe(
		"/admin?tab=settings",
	);
	expect(
		await screen.findByRole("table", { name: /Accounts and their workspaces/ }),
	).toBeDefined();
});

test("the tab comes from the address", async () => {
	stubAdmin(600);

	renderApp("/admin?tab=settings");

	expect(await screen.findByTestId("grace-input")).toBeDefined();
	const nav = screen.getByRole("navigation", { name: "Administration" });
	expect(within(nav).getByRole("link", { current: "page" }).textContent).toBe(
		"Settings",
	);
	expect(screen.queryByTestId("admin-accounts")).toBeNull();
});

test("an unknown tab falls back to Users", async () => {
	stubAdmin(600);

	renderApp("/admin?tab=nonsense");

	expect(await screen.findByTestId("admin-accounts")).toBeDefined();
});

test("the Settings tab shows the global grace period", async () => {
	stubAdmin(5400);

	renderApp("/admin?tab=settings");

	const input = (await screen.findByTestId("grace-input")) as HTMLInputElement;
	await waitFor(() => expect(input.value).toBe("5400"));
	expect(screen.getAllByText("1 hour 30 minutes").length).toBe(1);
});

test("zero reads as keeping workspaces running", async () => {
	stubAdmin(0);

	renderApp("/admin?tab=settings");

	await waitFor(() =>
		expect(
			screen.getAllByText("Workspaces keep running until stopped by hand").length,
		).toBeGreaterThan(0),
	);
});

test("saving the global value sends the seconds as a number", async () => {
	const writes: { url: string; body: unknown }[] = [];
	stubAdmin(600, (url, body) => writes.push({ url, body }));

	renderApp("/admin?tab=settings");

	const input = (await screen.findByTestId("grace-input")) as HTMLInputElement;
	await waitFor(() => expect(input.value).toBe("600"));
	fireEvent.change(input, { target: { value: "0" } });
	fireEvent.click(screen.getByTestId("grace-save"));

	await waitFor(() => expect(writes.length).toBe(1));
	expect(writes[0]).toEqual({
		url: "/admin/settings",
		body: { shutdownGraceSeconds: 0 },
	});
	expect(await screen.findByText("Grace period saved")).toBeDefined();
});

test("clearing a user's input sends null, and a number sets the override", async () => {
	const writes: { url: string; body: unknown }[] = [];
	stubAdmin(600, (url, body) => writes.push({ url, body }));

	renderApp("/admin");
	await openDetail("Alice Example");

	const input = await screen.findByTestId(`user-grace-input-${USER.id}`);
	await waitFor(() => expect((input as HTMLInputElement).value).toBe("30"));
	fireEvent.change(input, { target: { value: "" } });
	fireEvent.click(screen.getByTestId(`user-grace-save-${USER.id}`));

	await waitFor(() => expect(writes.length).toBe(1));
	expect(writes[0]).toEqual({
		url: `/admin/users/${USER.id}/settings`,
		body: { shutdownGraceSeconds: null },
	});

	fireEvent.change(input, { target: { value: "45" } });
	fireEvent.click(screen.getByTestId(`user-grace-save-${USER.id}`));

	await waitFor(() => expect(writes.length).toBe(2));
	expect(writes[1]?.body).toEqual({ shutdownGraceSeconds: 45 });
});

test("a user's override shows no default until the settings load", async () => {
	stubFetch((url) => {
		if (url === "/auth/me") return json(200, ADMIN);
		if (url === "/admin/users")
			return json(200, { users: [STUDENT_ROW, ADMIN_ROW], dexUsers: false });
		if (url === "/admin/settings") {
			return json(500, { code: "INTERNAL", message: "Settings are unavailable." });
		}
		throw new Error(`unexpected request: ${url}`);
	});

	renderApp("/admin");
	await openDetail("Carol Admin");

	// The account with no override claims no default, in the placeholder or the hint.
	const input = (await screen.findByTestId(
		`user-grace-input-${ADMIN.id}`,
	)) as HTMLInputElement;
	expect(input.value).toBe("");
	expect(input.placeholder).toBe("");
	expect(screen.queryByText(/^Default \(/)).toBeNull();
	expect(
		screen.queryByText("Workspaces keep running until stopped by hand"),
	).toBeNull();
});

test("the Settings tab shows a settings read failure", async () => {
	stubFetch((url) => {
		if (url === "/auth/me") return json(200, ADMIN);
		if (url === "/admin/settings") {
			return json(500, { code: "INTERNAL", message: "Settings are unavailable." });
		}
		throw new Error(`unexpected request: ${url}`);
	});

	renderApp("/admin?tab=settings");

	expect(await screen.findByText("Settings are unavailable.")).toBeDefined();
});

test("a value beyond the integer limit is refused before any request", async () => {
	const writes: { url: string; body: unknown }[] = [];
	stubAdmin(600, (url, body) => writes.push({ url, body }));

	renderApp("/admin?tab=settings");

	const input = (await screen.findByTestId("grace-input")) as HTMLInputElement;
	await waitFor(() => expect(input.value).toBe("600"));
	fireEvent.change(input, { target: { value: "2147483648" } });
	fireEvent.click(screen.getByTestId("grace-save"));

	expect(
		await screen.findByText("Enter a whole number of seconds, 0 or more."),
	).toBeDefined();
	expect(writes.length).toBe(0);
});

test("a student sent to /admin lands on the not-authorized page", async () => {
	stubFetch((url) => {
		if (url === "/auth/me") return json(200, USER);
		throw new Error(`unexpected request: ${url}`);
	});

	const { router } = renderApp("/admin");

	await waitFor(() => expect(router.state.location.pathname).toBe("/not-authorized"));
});

test("the log level select starts on the service default", async () => {
	stubAdmin(600);

	renderApp("/admin?tab=settings");

	const select = (await screen.findByTestId("log-level-select")) as HTMLSelectElement;
	await waitFor(() => expect(select.disabled).toBe(false));
	expect(select.value).toBe("default");
	expect(within(select).getByText("Use service default")).toBeDefined();
});

test("choosing a level sends only the log level, and the default sends null", async () => {
	const writes: { url: string; body: unknown }[] = [];
	stubAdmin(600, (url, body) => writes.push({ url, body }));

	renderApp("/admin?tab=settings");

	const select = (await screen.findByTestId("log-level-select")) as HTMLSelectElement;
	await waitFor(() => expect(select.disabled).toBe(false));
	fireEvent.change(select, { target: { value: "debug" } });
	fireEvent.click(screen.getByTestId("log-level-save"));

	await waitFor(() => expect(writes.length).toBe(1));
	expect(writes[0]).toEqual({ url: "/admin/settings", body: { logLevel: "debug" } });
	expect(await screen.findByText("Log level saved")).toBeDefined();

	fireEvent.change(select, { target: { value: "default" } });
	fireEvent.click(screen.getByTestId("log-level-save"));

	await waitFor(() => expect(writes.length).toBe(2));
	expect(writes[1]?.body).toEqual({ logLevel: null });
});

test("the grace form still sends only the seconds", async () => {
	const writes: { url: string; body: unknown }[] = [];
	stubAdmin(600, (url, body) => writes.push({ url, body }));

	renderApp("/admin?tab=settings");

	const input = (await screen.findByTestId("grace-input")) as HTMLInputElement;
	await waitFor(() => expect(input.value).toBe("600"));
	fireEvent.change(input, { target: { value: "900" } });
	fireEvent.click(screen.getByTestId("grace-save"));

	await waitFor(() => expect(writes.length).toBe(1));
	expect(writes[0]?.body).toEqual({ shutdownGraceSeconds: 900 });
});

test("the grace field is named by its visible label and Save after the user (WCAG 2.5.3, issue #371)", async () => {
	stubAdmin(600);

	renderApp("/admin");
	await openDetail("Alice Example");

	expect(screen.getByRole("textbox", { name: "Grace period override (seconds)" })).toBe(
		screen.getByTestId(`user-grace-input-${USER.id}`),
	);
	expect(screen.getByRole("button", { name: "Save Alice Example" })).toBe(
		screen.getByTestId(`user-grace-save-${USER.id}`),
	);
	// Each row's details button says whose row it is.
	expect(
		screen.getByRole("button", { name: /^Show details for Carol Admin, / }),
	).toBeDefined();
});

test("the page is titled Administration (issue #374)", async () => {
	stubAdmin(600);

	renderApp("/admin");

	await screen.findByTestId("page-admin");
	expect(document.title).toBe("Administration, Portikus");
});

test("grace-period errors are announced as alerts (issue #363)", async () => {
	stubAdmin(600);

	renderApp("/admin?tab=settings");

	const input = (await screen.findByTestId("grace-input")) as HTMLInputElement;
	await waitFor(() => expect(input.value).toBe("600"));
	fireEvent.change(input, { target: { value: "soon" } });
	fireEvent.click(screen.getByTestId("grace-save"));
	expect((await screen.findByRole("alert")).textContent).toBe(
		"Enter a whole number of seconds, 0 or more.",
	);
});

test("a user's grace error is announced as an alert (issue #363)", async () => {
	stubAdmin(600);

	renderApp("/admin");
	await openDetail("Alice Example");

	const row = screen.getByTestId(`user-grace-input-${USER.id}`);
	fireEvent.change(row, { target: { value: "later" } });
	fireEvent.click(screen.getByTestId(`user-grace-save-${USER.id}`));
	expect((await screen.findByRole("alert")).textContent).toBe(
		"Enter a whole number of seconds, 0 or more.",
	);
});

test("a failed log-level save is an alert tied to the select (issue #363)", async () => {
	stubFetch((url, init) => {
		if (url === "/auth/me") return json(200, ADMIN);
		if (url === "/admin/settings" && init?.method === "PUT") {
			return json(500, { error: "internal", message: "Something broke" });
		}
		if (url === "/admin/settings") {
			return json(200, { shutdownGraceSeconds: 600, logLevel: null, updatedAt: null });
		}
		throw new Error(`unexpected request: ${url}`);
	});

	renderApp("/admin?tab=settings");

	const select = (await screen.findByTestId("log-level-select")) as HTMLSelectElement;
	await waitFor(() => expect(select.disabled).toBe(false));
	fireEvent.change(select, { target: { value: "debug" } });
	fireEvent.click(screen.getByTestId("log-level-save"));

	const error = await screen.findByRole("alert");
	expect(select.getAttribute("aria-invalid")).toBe("true");
	expect(select.getAttribute("aria-describedby")).toBe(error.id);
});

test("the Audit tab's filters survive in the address, and bad values are dropped", async () => {
	stubAdmin(600);
	const workspace = "22222222-2222-4222-8222-222222222222";

	const { router } = renderApp(
		`/admin?tab=audit&workspace=${workspace}&user=not-a-uuid&action=workspace.`,
	);

	await screen.findByTestId("page-admin");
	expect(router.state.location.search).toEqual({
		tab: "audit",
		workspace,
		user: undefined,
		action: "workspace.",
	});
});

/** The admin reads, with `POST /workspaces` answered by `ensure`. */
function stubAdminWithWorkspace(ensure: () => Response | Promise<Response>) {
	return stubFetch((url, init) => {
		if (url === "/auth/me") return json(200, ADMIN);
		if (url === "/workspaces" && init?.method === "POST") return ensure() as Response;
		if (url === "/admin/users") {
			return json(200, { users: [STUDENT_ROW, ADMIN_ROW], dexUsers: false });
		}
		if (url.endsWith("/templates")) return json(200, { templates: [] });
		if (url.includes("/projects")) return json(200, { projects: [] });
		return json(200, {});
	});
}

async function openMyWorkspaceItem(): Promise<HTMLElement> {
	fireEvent.pointerDown(await screen.findByTestId("me"), { button: 0, ctrlKey: false });
	return screen.findByTestId("open-my-workspace");
}

function workspacePosts(fetch: ReturnType<typeof stubFetch>): number {
	return fetch.mock.calls.filter(
		([url, init]) => url === "/workspaces" && init?.method === "POST",
	).length;
}

test("Open my workspace makes the workspace and goes there (issue #534)", async () => {
	vi.stubGlobal("WebSocket", FakeWebSocket);
	const fetch = stubAdminWithWorkspace(() =>
		json(201, { ...WORKSPACE, ownerUserId: ADMIN.id }),
	);
	const { router } = renderApp("/admin");

	const item = await openMyWorkspaceItem();
	expect(item.textContent).toBe("Open my workspace");
	expect(screen.queryByTestId("back-to-workspace")).toBeNull();
	// A menu item now, not a header button (issue #550).
	expect(screen.queryByRole("button", { name: "Open my workspace" })).toBeNull();
	// Nothing is made until the administrator asks.
	expect(workspacePosts(fetch)).toBe(0);

	fireEvent.click(item);

	await waitFor(() =>
		expect(router.state.location.pathname).toBe(`/workspaces/${WORKSPACE.id}`),
	);
	expect(workspacePosts(fetch)).toBe(1);
});

test("Open my workspace shows it is working, then an error as a toast", async () => {
	const waiting: ((response: Response) => void)[] = [];
	const fetch = stubAdminWithWorkspace(
		() =>
			new Promise<Response>((resolve) => {
				waiting.push(resolve);
			}),
	);
	const { router } = renderApp("/admin");

	fireEvent.click(await openMyWorkspaceItem());

	// The live region sits outside the menu, so it announces after the menu closes.
	const status = screen.getByTestId("open-my-workspace-status");
	expect(status.getAttribute("role")).toBe("status");
	await waitFor(() => expect(status.textContent).toBe("Opening your workspace"));
	// Visible while pending, not only to screen readers.
	expect(status.className).not.toContain("sr-only");
	expect(screen.queryByTestId("open-my-workspace")).toBeNull();

	// Choosing it again while it is opening sends no second request.
	const again = await openMyWorkspaceItem();
	expect(again.textContent).toBe("Opening your workspace…");
	expect(again.getAttribute("aria-disabled")).toBe("true");
	fireEvent.click(again);
	// mutate() fetches after a microtask, so let a second request go out before counting.
	await act(async () => {});
	expect(workspacePosts(fetch)).toBe(1);
	fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

	for (const answer of waiting) {
		answer(json(503, { code: "UNAVAILABLE", message: "Try again soon." }));
	}

	expect(await screen.findByText("Your workspace did not open")).toBeDefined();
	expect(status.textContent).toBe("");
	expect(status.className).toContain("sr-only");
	expect(router.state.location.pathname).toBe("/admin");
});
