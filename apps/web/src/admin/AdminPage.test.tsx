import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { json, renderApp, stubFetch, USER } from "../test-utils.js";

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
	disabledAt: null,
	shutdownGraceSeconds: 30,
};

const ADMIN_ROW = {
	id: ADMIN.id,
	displayName: ADMIN.displayName,
	email: ADMIN.email,
	role: "administrator" as const,
	disabledAt: "2026-01-01T00:00:00.000Z",
	shutdownGraceSeconds: null,
};

/** Answers the three admin reads; `onWrite` sees every PUT body. */
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
			return json(200, { users: [STUDENT_ROW, ADMIN_ROW] });
		}
		throw new Error(`unexpected request: ${url}`);
	});
}

test("the page shows the global grace period and the users", async () => {
	stubAdmin(5400);

	renderApp("/admin");

	const input = (await screen.findByTestId("grace-input")) as HTMLInputElement;
	await waitFor(() => expect(input.value).toBe("5400"));
	// Once under the global input, once for the user with no override.
	expect(screen.getAllByText("1 hour 30 minutes").length).toBe(2);
	const table = within(await screen.findByTestId("admin-users"));
	expect(await table.findByText("Carol Admin")).toBeDefined();
	expect(table.getByText("Alice Example")).toBeDefined();
	// The disabled administrator says so in the role cell.
	expect(table.getByText("Disabled")).toBeDefined();
});

test("zero reads as keeping workspaces running", async () => {
	stubAdmin(0);

	renderApp("/admin");

	await waitFor(() =>
		expect(
			screen.getAllByText("Workspaces keep running until stopped by hand").length,
		).toBeGreaterThan(0),
	);
});

test("saving the global value sends the seconds as a number", async () => {
	const writes: { url: string; body: unknown }[] = [];
	stubAdmin(600, (url, body) => writes.push({ url, body }));

	renderApp("/admin");

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

test("the users table shows no default until the settings load", async () => {
	stubFetch((url) => {
		if (url === "/auth/me") return json(200, ADMIN);
		if (url === "/admin/users") return json(200, { users: [STUDENT_ROW, ADMIN_ROW] });
		if (url === "/admin/settings") {
			return json(500, { code: "INTERNAL", message: "Settings are unavailable." });
		}
		throw new Error(`unexpected request: ${url}`);
	});

	renderApp("/admin");

	// The failure is shown under the global input.
	expect(await screen.findByText("Settings are unavailable.")).toBeDefined();
	// The row with no override claims no default, in the placeholder or the hint.
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

test("a value beyond the integer limit is refused before any request", async () => {
	const writes: { url: string; body: unknown }[] = [];
	stubAdmin(600, (url, body) => writes.push({ url, body }));

	renderApp("/admin");

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

	renderApp("/admin");

	const select = (await screen.findByTestId("log-level-select")) as HTMLSelectElement;
	await waitFor(() => expect(select.disabled).toBe(false));
	expect(select.value).toBe("default");
	expect(within(select).getByText("Use service default")).toBeDefined();
});

test("choosing a level sends only the log level, and the default sends null", async () => {
	const writes: { url: string; body: unknown }[] = [];
	stubAdmin(600, (url, body) => writes.push({ url, body }));

	renderApp("/admin");

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

	renderApp("/admin");

	const input = (await screen.findByTestId("grace-input")) as HTMLInputElement;
	await waitFor(() => expect(input.value).toBe("600"));
	fireEvent.change(input, { target: { value: "900" } });
	fireEvent.click(screen.getByTestId("grace-save"));

	await waitFor(() => expect(writes.length).toBe(1));
	expect(writes[0]?.body).toEqual({ shutdownGraceSeconds: 900 });
});
