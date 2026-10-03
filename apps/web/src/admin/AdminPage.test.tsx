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
) {
	return stubFetch((url, init) => {
		if (url === "/auth/me") return json(200, ADMIN);
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
		if (url === "/admin/users") {
			return json(200, { users: [STUDENT_ROW, ADMIN_ROW], dexUsers: false });
		}
		if (url.startsWith("/admin/logs?")) {
			return json(200, {
				lines: [],
				nextCursor: null,
				scanComplete: true,
				skippedLines: 0,
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
		"Network",
		"Backups",
		"Workspace image",
		"Certificate",
		"Docker",
		"Settings",
	]);
	expect(
		await screen.findByRole("table", { name: /Accounts and their workspaces/ }),
	).toBeDefined();
});

test("the tab comes from the address", async () => {
	stubAdmin(600);

	renderApp("/admin/settings");

	expect(await screen.findByTestId("grace-input")).toBeDefined();
	const nav = screen.getByRole("navigation", { name: "Administration" });
	expect(within(nav).getByRole("link", { current: "page" }).textContent).toBe(
		"Settings",
	);
	expect(screen.queryByTestId("admin-accounts")).toBeNull();
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

test("the Settings tab shows the global grace period in minutes", async () => {
	stubAdmin(5400);

	renderApp("/admin/settings");

	const input = (await screen.findByTestId("grace-input")) as HTMLInputElement;
	await waitFor(() => expect(input.value).toBe("90"));
	expect(screen.getAllByText("1 hour 30 minutes").length).toBe(1);
});

test("zero reads as keeping workspaces running", async () => {
	stubAdmin(0);

	renderApp("/admin/settings");

	await waitFor(() =>
		expect(
			screen.getAllByText("Workspaces keep running until stopped by hand").length,
		).toBeGreaterThan(0),
	);
});

test("saving the global value sends the seconds as a number", async () => {
	const writes: { url: string; body: unknown }[] = [];
	stubAdmin(600, (url, body) => writes.push({ url, body }));

	renderApp("/admin/settings");

	const input = (await screen.findByTestId("grace-input")) as HTMLInputElement;
	await waitFor(() => expect(input.value).toBe("10"));
	fireEvent.change(input, { target: { value: "0" } });
	fireEvent.click(screen.getByTestId("grace-save"));

	await waitFor(() => expect(writes.length).toBe(1));
	expect(writes[0]).toEqual({
		url: "/admin/settings",
		body: { shutdownGraceSeconds: 0 },
	});
	expect(await screen.findByText("Grace period saved")).toBeDefined();
});

test("the Settings tab shows a settings read failure", async () => {
	stubFetch((url) => {
		if (url === "/auth/me") return json(200, ADMIN);
		if (url === "/admin/settings") {
			return json(500, { code: "INTERNAL", message: "Settings are unavailable." });
		}
		throw new Error(`unexpected request: ${url}`);
	});

	renderApp("/admin/settings");

	expect(await screen.findByText("Settings are unavailable.")).toBeDefined();
});

test("a value beyond the integer limit is refused before any request", async () => {
	const writes: { url: string; body: unknown }[] = [];
	stubAdmin(600, (url, body) => writes.push({ url, body }));

	renderApp("/admin/settings");

	const input = (await screen.findByTestId("grace-input")) as HTMLInputElement;
	await waitFor(() => expect(input.value).toBe("10"));
	fireEvent.change(input, { target: { value: "35791395" } });
	fireEvent.click(screen.getByTestId("grace-save"));

	expect(
		await screen.findByText("Enter a number of minutes, 0 or more."),
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

test("the grace form takes minutes and still sends only the seconds", async () => {
	const writes: { url: string; body: unknown }[] = [];
	stubAdmin(600, (url, body) => writes.push({ url, body }));

	renderApp("/admin/settings");

	const input = (await screen.findByTestId("grace-input")) as HTMLInputElement;
	await waitFor(() => expect(input.value).toBe("10"));
	expect(input).toBe(
		screen.getByRole("textbox", { name: "Disconnect grace (minutes)" }),
	);
	fireEvent.change(input, { target: { value: "15" } });
	fireEvent.click(screen.getByTestId("grace-save"));

	await waitFor(() => expect(writes.length).toBe(1));
	expect(writes[0]?.body).toEqual({ shutdownGraceSeconds: 900 });
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

test("grace-period errors are announced as alerts", async () => {
	stubAdmin(600);

	renderApp("/admin/settings");

	const input = (await screen.findByTestId("grace-input")) as HTMLInputElement;
	await waitFor(() => expect(input.value).toBe("10"));
	fireEvent.change(input, { target: { value: "soon" } });
	fireEvent.click(screen.getByTestId("grace-save"));
	expect((await screen.findByRole("alert")).textContent).toBe(
		"Enter a number of minutes, 0 or more.",
	);
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

test("idle stop saves the minutes and refuses a value between 1 and 9", async () => {
	const writes: { url: string; body: unknown }[] = [];
	stubAdmin(600, (url, body) => writes.push({ url, body }));
	renderApp("/admin/settings");

	const input = (await screen.findByTestId("idle-input")) as HTMLInputElement;
	await waitFor(() => expect(input.value).toBe("60"));
	fireEvent.change(input, { target: { value: "5" } });
	fireEvent.click(screen.getByTestId("idle-save"));
	expect((await screen.findByRole("alert")).textContent).toBe(
		"Enter 0 for never, or a whole number from 10 to 1440.",
	);
	expect(writes).toEqual([]);

	fireEvent.change(input, { target: { value: "0" } });
	fireEvent.click(screen.getByTestId("idle-save"));
	await waitFor(() => expect(writes.length).toBe(1));
	expect(writes[0]).toEqual({ url: "/admin/settings", body: { idleStopMinutes: 0 } });
});

test("the resource guard saves its values and names each bad one", async () => {
	const writes: { url: string; body: unknown }[] = [];
	stubAdmin(600, (url, body) => writes.push({ url, body }));
	renderApp("/admin/settings");

	const cpu = (await screen.findByLabelText("CPU threshold (%)")) as HTMLInputElement;
	await waitFor(() => expect(cpu.value).toBe("80"));
	fireEvent.change(cpu, { target: { value: "0" } });
	fireEvent.change(screen.getByLabelText("Window (minutes)"), {
		target: { value: "300" },
	});
	fireEvent.click(screen.getByTestId("guard-settings-save"));

	// One alert for the first problem; the second field is marked too.
	expect((await screen.findByRole("alert")).textContent).toBe(
		"Enter a whole number from 1 to 100.",
	);
	expect(screen.getByText("Enter a whole number from 5 to 240.")).toBeDefined();
	expect(cpu.getAttribute("aria-invalid")).toBe("true");
	expect(writes).toEqual([]);

	fireEvent.change(cpu, { target: { value: "70" } });
	fireEvent.change(screen.getByLabelText("Window (minutes)"), {
		target: { value: "45" },
	});
	fireEvent.click(screen.getByTestId("guard-settings-save"));
	await waitFor(() => expect(writes.length).toBe(1));
	expect(writes[0]).toEqual({
		url: "/admin/settings",
		body: {
			cpuGuardThresholdPercent: 70,
			memoryGuardThresholdPercent: 90,
			guardWindowMinutes: 45,
			cpuThrottleSharePercent: 25,
			cpuIdleLiftMinutes: 5,
			cpuIdleLiftPercent: 10,
			cpuThrottleHoldAfter: 3,
			cpuThrottleHoldHours: 24,
		},
	});
	expect(await screen.findByText("Resource guard saved")).toBeDefined();
});

test("the automatic lift fields save, allow 0 to turn it off, and name a bad value", async () => {
	const writes: { url: string; body: unknown }[] = [];
	stubAdmin(600, (url, body) => writes.push({ url, body }));
	renderApp("/admin/settings");

	const minutes = (await screen.findByLabelText(
		"Quiet time to lift (minutes)",
	)) as HTMLInputElement;
	const percent = screen.getByLabelText("Quiet below (%)") as HTMLInputElement;
	await waitFor(() => expect(minutes.value).toBe("5"));
	expect(percent.value).toBe("10");

	fireEvent.change(minutes, { target: { value: "61" } });
	fireEvent.click(screen.getByTestId("guard-settings-save"));
	const alert = await screen.findByRole("alert");
	expect(alert.textContent).toBe("Enter a whole number from 1 to 60.");
	expect(minutes.getAttribute("aria-invalid")).toBe("true");
	// The error is tied to its field.
	const described = document.getElementById(
		minutes.getAttribute("aria-describedby") ?? "",
	);
	expect(described?.textContent).toContain("Enter a whole number from 1 to 60.");
	expect(writes).toEqual([]);

	fireEvent.change(minutes, { target: { value: "15" } });
	fireEvent.change(percent, { target: { value: "0" } });
	fireEvent.click(screen.getByTestId("guard-settings-save"));
	await waitFor(() => expect(writes.length).toBe(1));
	expect(writes[0]?.body).toMatchObject({
		cpuIdleLiftMinutes: 15,
		cpuIdleLiftPercent: 0,
	});
});

test("the throttle-hold fields save, allow 0 to turn it off, and name a bad value (SPEC.md §19.4)", async () => {
	const writes: { url: string; body: unknown }[] = [];
	stubAdmin(600, (url, body) => writes.push({ url, body }));
	renderApp("/admin/settings");

	const after = (await screen.findByLabelText(
		"Hold after throttles",
	)) as HTMLInputElement;
	const hours = screen.getByLabelText("Hold window (hours)") as HTMLInputElement;
	await waitFor(() => expect(after.value).toBe("3"));
	expect(hours.value).toBe("24");

	fireEvent.change(hours, { target: { value: "169" } });
	fireEvent.click(screen.getByTestId("guard-settings-save"));
	const alert = await screen.findByRole("alert");
	expect(alert.textContent).toBe("Enter a whole number from 1 to 168.");
	expect(writes).toEqual([]);

	fireEvent.change(hours, { target: { value: "48" } });
	fireEvent.change(after, { target: { value: "0" } });
	fireEvent.click(screen.getByTestId("guard-settings-save"));
	await waitFor(() => expect(writes.length).toBe(1));
	expect(writes[0]?.body).toMatchObject({
		cpuThrottleHoldAfter: 0,
		cpuThrottleHoldHours: 48,
	});
});

test("the acceptable-use section starts on the default, says everyone accepts again, and saves", async () => {
	const writes: { url: string; body: unknown }[] = [];
	stubAdmin(600, (url, body) => writes.push({ url, body }));
	renderApp("/admin/settings");

	const text = (await screen.findByLabelText("Statement")) as HTMLTextAreaElement;
	await waitFor(() =>
		expect(text.value).toContain("Your Portikus workspace is for coursework"),
	);
	expect(screen.getByText(/This is version 1\./)).toBeDefined();
	const save = screen.getByTestId("aup-save");
	const sentence = document.getElementById(save.getAttribute("aria-describedby") ?? "");
	expect(sentence?.textContent).toContain(
		"asks everyone, you included, to accept it again",
	);

	fireEvent.change(text, { target: { value: "   " } });
	fireEvent.click(save);
	expect((await screen.findByRole("alert")).textContent).toBe(
		"Enter the statement, or reset it to the default.",
	);
	expect(writes).toEqual([]);

	fireEvent.change(text, { target: { value: "Be kind." } });
	fireEvent.click(save);
	await waitFor(() => expect(writes.length).toBe(1));
	expect(writes[0]).toEqual({
		url: "/admin/settings",
		body: { acceptableUseText: "Be kind." },
	});

	fireEvent.click(screen.getByTestId("aup-reset"));
	await waitFor(() => expect(writes.length).toBe(2));
	expect(writes[1]).toEqual({
		url: "/admin/settings",
		body: { acceptableUseText: null },
	});
});

test("a statement over the limit is refused before any request", async () => {
	const writes: unknown[] = [];
	stubAdmin(600, (url, body) => writes.push({ url, body }));
	renderApp("/admin/settings");

	const text = (await screen.findByLabelText("Statement")) as HTMLTextAreaElement;
	fireEvent.change(text, { target: { value: "x".repeat(10_001) } });
	expect(screen.getByText("10,001 of 10,000 characters")).toBeDefined();
	fireEvent.click(screen.getByTestId("aup-save"));
	expect((await screen.findByRole("alert")).textContent).toBe(
		"The statement can be at most 10,000 characters.",
	);
	expect(writes).toEqual([]);
});

test("a small gap starts each group of admin tabs", async () => {
	stubAdmin(600);
	renderApp("/admin");
	const nav = await screen.findByRole("navigation", { name: "Administration" });
	const gapped = within(nav)
		.getAllByRole("link")
		.filter((link) => link.classList.contains("ms-4"))
		.map((link) => link.textContent);
	expect(gapped).toEqual(["Health", "Network"]);
});

test("the tabs sit in the app header before the account button, and the h1 stays", async () => {
	stubAdmin(600);
	renderApp("/admin/health");
	const header = await screen.findByTestId("app-header");
	const nav = within(header).getByRole("navigation", { name: "Administration" });
	expect(within(nav).getByRole("link", { current: "page" }).textContent).toBe("Health");
	// Tab order follows reading order: the tabs, then the account button.
	const account = within(header).getByTestId("me");
	expect(
		nav.compareDocumentPosition(account) & Node.DOCUMENT_POSITION_FOLLOWING,
	).toBeTruthy();
	const main = screen.getByTestId("page-admin");
	expect(within(main).queryByRole("navigation")).toBeNull();
	// The outline still starts with an h1 that names <main>.
	const h1 = screen.getByRole("heading", { level: 1, name: "Administration" });
	expect(main.getAttribute("aria-labelledby")).toBe(h1.id);
});
