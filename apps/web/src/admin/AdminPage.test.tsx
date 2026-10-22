import { NOTIFY_FILE_OFF, notificationSettingsView } from "@portikus/contracts";
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
import { isUsersList, usersBody } from "./users/testRows.js";

afterEach(() => vi.unstubAllGlobals());

const ADMIN = {
	...USER,
	id: "33333333-3333-4333-8333-333333333333",
	displayName: "Carol Admin",
	email: "carol@example.invalid",
	role: "administrator" as const,
};

/** The resource guard and acceptable-use settings at their defaults. */
const GUARD_SETTINGS = {
	cpuGuardThresholdPercent: 80,
	memoryGuardThresholdPercent: 90,
	guardWindowMinutes: 30,
	cpuThrottleSharePercent: 25,
	cpuIdleLiftMinutes: 5,
	cpuIdleLiftPercent: 10,
	cpuThrottleHoldAfter: 3,
	cpuThrottleHoldHours: 24,
	keepRunningMaxHours: 12,
	voiceInputEnabled: true,
	codeHelpLanguages: ["python", "typescript"],
	accountEmailEnabled: false,
	idleStopMinutes: 60,
	acceptableUseText: null,
	acceptableUseVersion: 1,
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
		notSignedInYet: false,
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
		notSignedInYet: false,
		linked: false,
	},
	workspace: null,
};

/** Answers the admin reads; `onWrite` sees every PUT body. */
function stubAdmin(
	graceSeconds: number,
	onWrite?: (url: string, body: unknown) => void,
	rootShell = false,
) {
	return stubFetch((url, init) => {
		if (url === "/auth/me") return json(200, ADMIN);
		if (url === "/admin/root-shell") return json(200, { enabled: rootShell });
		if (url === "/admin/settings" && init?.method === "PUT") {
			const body = JSON.parse(String(init.body));
			onWrite?.(url, body);
			return json(200, {
				...GUARD_SETTINGS,
				shutdownGraceSeconds: body.shutdownGraceSeconds ?? graceSeconds,
				logLevel: body.logLevel ?? null,
				updatedAt: "2026-01-01T00:00:00.000Z",
			});
		}
		if (url === "/admin/settings") {
			return json(200, {
				...GUARD_SETTINGS,
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
		if (isUsersList(url)) {
			return usersBody(url, [STUDENT_ROW, ADMIN_ROW], false);
		}
		if (url.startsWith("/admin/logs?")) {
			return json(200, {
				lines: [],
				nextCursor: null,
				scanComplete: true,
				skippedLines: 0,
			});
		}
		if (url === "/admin/notifications") {
			return json(200, {
				settings: notificationSettingsView(NOTIFY_FILE_OFF),
				job: null,
				storedFileUnreadable: false,
			});
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
	// Relabelled Users (ADR 0026); its path is /admin/users.
	expect(current.textContent).toBe("Users");
	expect(current.getAttribute("href")).toBe("/admin/users");
	expect(within(nav).getByRole("link", { name: "Settings" }).getAttribute("href")).toBe(
		"/admin/settings",
	);
	// People, then what to look at, then what to change.
	expect(
		within(nav)
			.getAllByRole("link")
			.map((link) => link.textContent),
	).toEqual([
		"Users",
		"Health",
		"Logs",
		"Audit",
		"Agent usage",
		"Network",
		"Backups",
		"Workspace image",
		"Certificate",
		"Docker",
		"Sign-in",
		"Site address",
		"Settings",
	]);
	expect(
		await screen.findByRole("table", { name: /Accounts and their workspaces/ }),
	).toBeDefined();
});

test("a server that offers root shells shows the Root shell tab last (ADR 0051)", async () => {
	stubAdmin(600, undefined, true);

	renderApp("/admin");

	const nav = await screen.findByRole("navigation", { name: "Administration" });
	await waitFor(() =>
		expect(within(nav).getAllByRole("link").at(-1)?.textContent).toBe("Root shell"),
	);
	expect(
		within(nav).getByRole("link", { name: "Root shell" }).getAttribute("href"),
	).toBe("/admin/shell");
});

test("with root shells off the tab is hidden and its address says why", async () => {
	stubAdmin(600);

	renderApp("/admin/shell");

	expect(
		await screen.findByText("Root shells are turned off on this server"),
	).toBeDefined();
	const nav = screen.getByRole("navigation", { name: "Administration" });
	expect(within(nav).queryByRole("link", { name: "Root shell" })).toBeNull();
	expect(screen.getByRole("heading", { level: 2, name: "Root shell" })).toBeDefined();
});

test("the tab comes from the address", async () => {
	stubAdmin(600);

	renderApp("/admin/settings");

	expect(await screen.findByTestId("settings-shutdownGraceSeconds")).toBeDefined();
	const nav = screen.getByRole("navigation", { name: "Administration" });
	expect(within(nav).getByRole("link", { current: "page" }).textContent).toBe(
		"Settings",
	);
	expect(screen.queryByTestId("admin-accounts")).toBeNull();
});

test("the Sign-in and Site address tabs have their own paths and headings (ADR 0059)", async () => {
	stubAdmin(600);

	const { router } = renderApp("/admin/signin");

	expect(
		await screen.findByRole("heading", { level: 2, name: "Sign-in" }),
	).toBeDefined();
	expect(
		screen.getByRole("heading", { level: 3, name: "Single sign-on" }),
	).toBeDefined();
	expect(
		screen.getByRole("heading", { level: 3, name: "Learning management systems" }),
	).toBeDefined();
	const nav = screen.getByRole("navigation", { name: "Administration" });
	expect(within(nav).getByRole("link", { current: "page" }).textContent).toBe(
		"Sign-in",
	);
	await waitFor(() => expect(document.title).toBe("Sign-in, Administration, Portikus"));

	fireEvent.click(within(nav).getByRole("link", { name: "Site address" }));
	expect(
		await screen.findByRole("heading", { level: 2, name: "Site address" }),
	).toBeDefined();
	expect(router.state.location.pathname).toBe("/admin/address");
	expect(screen.queryByRole("heading", { level: 2, name: "Sign-in" })).toBeNull();
});

test("an old ?tab= link moves to the tab's path and keeps the other keys", async () => {
	stubAdmin(600);
	const workspace = "11111111-2222-4333-8444-555555555555";

	const { router } = renderApp(
		`/admin?tab=audit&workspace=${workspace}&action=workspace.`,
	);

	await waitFor(() => expect(router.state.location.pathname).toBe("/admin/audit"));
	expect(router.state.location.search).toMatchObject({
		workspace,
		action: "workspace.",
	});
	expect(router.state.location.search).not.toHaveProperty("tab");
});

test("the Users tab's old ?tab=workspaces address opens /admin/users", async () => {
	stubAdmin(600);

	const { router } = renderApp("/admin?tab=workspaces");

	await waitFor(() => expect(router.state.location.pathname).toBe("/admin/users"));
	expect(await screen.findByTestId("admin-accounts")).toBeDefined();
});

test("an unknown tab falls back to Users", async () => {
	stubAdmin(600);

	renderApp("/admin/nonsense");

	expect(await screen.findByTestId("admin-accounts")).toBeDefined();
});

test("the Settings tab shows a settings read failure", async () => {
	stubFetch((url) => {
		if (url === "/auth/me") return json(200, ADMIN);
		if (url === "/admin/settings") {
			return json(500, { code: "INTERNAL", message: "Settings are unavailable." });
		}
		if (url === "/admin/notifications") {
			return json(200, {
				settings: notificationSettingsView(NOTIFY_FILE_OFF),
				job: null,
				storedFileUnreadable: false,
			});
		}
		throw new Error(`unexpected request: ${url}`);
	});

	renderApp("/admin/settings");

	expect(
		(await screen.findAllByText(/Settings are unavailable\./))[0]?.textContent,
	).toContain("These settings could not be loaded.");
});

test("a student sent to /admin lands on the not-authorized page", async () => {
	stubFetch((url) => {
		if (url === "/auth/me") return json(200, USER);
		if (url === "/admin/notifications") {
			return json(200, {
				settings: notificationSettingsView(NOTIFY_FILE_OFF),
				job: null,
				storedFileUnreadable: false,
			});
		}
		throw new Error(`unexpected request: ${url}`);
	});

	const { router } = renderApp("/admin");

	await waitFor(() => expect(router.state.location.pathname).toBe("/not-authorized"));
});

test("the page title names the tab (SPEC.md section 20.1)", async () => {
	stubAdmin(600);

	renderApp("/admin");

	await screen.findByTestId("page-admin");
	expect(document.title).toBe("Users, Administration, Portikus");
});

test("a link that switches tabs puts focus on the new tab's heading", async () => {
	stubAdmin(600);
	renderApp("/admin");
	await openDetail(USER.displayName);
	const link = screen.getByRole("link", { name: "View this user's logs" });
	expect(link.getAttribute("href")).toBe(`/admin/logs?user=${USER.id}`);
	link.focus();
	fireEvent.click(link);
	const heading = await screen.findByRole("heading", { level: 2, name: "Logs" });
	await waitFor(() => expect(document.activeElement).toBe(heading));
});

test("choosing a tab in the tab bar leaves focus on that tab link", async () => {
	stubAdmin(600);
	renderApp("/admin");
	await screen.findByTestId("admin-accounts");
	const tab = screen.getByTestId("admin-tab-settings");
	tab.focus();
	fireEvent.click(tab);
	await screen.findByRole("heading", { level: 2, name: "Settings" });
	expect(document.activeElement).toBe(tab);
});

test("a tab change is announced in a polite status region, without moving focus", async () => {
	stubAdmin(600);
	renderApp("/admin");
	await screen.findByTestId("admin-accounts");
	const region = screen.getByTestId("admin-tab-announce");
	expect(region.getAttribute("aria-live")).toBe("polite");
	expect(region.textContent).toBe("");
	const tab = screen.getByTestId("admin-tab-settings");
	tab.focus();
	fireEvent.click(tab);
	await waitFor(() => expect(region.textContent).toBe("Settings tab"));
	expect(screen.getByTestId("admin-tab-announce")).toBe(region);
	expect(document.activeElement).toBe(tab);
});

test("the Settings tab has its own title and an h2 naming it", async () => {
	stubAdmin(600);

	renderApp("/admin/settings");

	expect(
		await screen.findByRole("heading", { level: 2, name: "Settings" }),
	).toBeDefined();
	expect(document.title).toBe("Settings, Administration, Portikus");
});

test("the admin page is compact (SPEC.md section 20.1)", async () => {
	stubAdmin(600);

	renderApp("/admin");

	const main = await screen.findByTestId("page-admin");
	expect(main.getAttribute("data-density")).toBe("compact");
});

test("the Audit tab's filters survive in the address, and bad values are dropped", async () => {
	stubAdmin(600);
	const workspace = "22222222-2222-4222-8222-222222222222";

	const { router } = renderApp(
		`/admin/audit?workspace=${workspace}&user=not-a-uuid&action=workspace.`,
	);

	await screen.findByTestId("page-admin");
	expect(router.state.location.search).toEqual({
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
		if (isUsersList(url)) {
			return usersBody(url, [STUDENT_ROW, ADMIN_ROW], false);
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

test("Open my workspace makes the workspace and goes there", async () => {
	vi.stubGlobal("WebSocket", FakeWebSocket);
	const fetch = stubAdminWithWorkspace(() =>
		json(201, { ...WORKSPACE, ownerUserId: ADMIN.id }),
	);
	const { router } = renderApp("/admin");

	const item = await openMyWorkspaceItem();
	expect(item.textContent).toBe("Open my workspace");
	expect(screen.queryByTestId("back-to-workspace")).toBeNull();
	// A menu item now, not a header button.
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
	expect(router.state.location.pathname).toBe("/admin/users");
});

test("the tabs sit under the app header and before main, and the h1 stays", async () => {
	stubAdmin(600);
	renderApp("/admin/health");
	const header = await screen.findByTestId("app-header");
	const nav = screen.getByRole("navigation", { name: "Administration" });
	expect(header.contains(nav)).toBe(false);
	expect(within(nav).getByRole("link", { current: "page" }).textContent).toBe("Health");
	// Tab order follows reading order: the account button, the tabs, then the content.
	const main = screen.getByTestId("page-admin");
	expect(
		header.compareDocumentPosition(nav) & Node.DOCUMENT_POSITION_FOLLOWING,
	).toBeTruthy();
	expect(
		nav.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING,
	).toBeTruthy();
	expect(within(main).queryByRole("navigation")).toBeNull();
	// The outline still starts with an h1 that names <main>.
	const h1 = screen.getByRole("heading", { level: 1, name: "Administration" });
	expect(main.getAttribute("aria-labelledby")).toBe(h1.id);
});
