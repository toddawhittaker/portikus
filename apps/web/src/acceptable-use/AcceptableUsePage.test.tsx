/** The acceptable-use page (docs/EPIC-14-3.md rulings 29, 32 and 33). */
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { json, renderApp, stubFetch, USER, WORKSPACE } from "../test-utils.js";
import { paragraphs } from "./AcceptableUsePage.js";

afterEach(() => vi.unstubAllGlobals());

const UNACCEPTED = { ...USER, mustAcceptUse: true };
const STATEMENT = { text: "First rule.\n\nSecond rule,\nsame paragraph.", version: 3 };

test("blank lines separate paragraphs; single line breaks do not", () => {
	expect(paragraphs("One.\n\n\nTwo\nstill two.\n  \nThree.\n")).toEqual([
		"One.",
		"Two\nstill two.",
		"Three.",
	]);
});

test("an account that has not accepted is sent to the statement from any page", async () => {
	const fetch = stubFetch((url) => {
		// A student, so /admin's own "not for you" redirect must not fight the gate.
		if (url === "/auth/me") return json(200, UNACCEPTED);
		if (url === "/me/acceptable-use") return json(200, STATEMENT);
		return json(403, { code: "ACCEPTABLE_USE_REQUIRED", message: "no" });
	});

	for (const path of ["/", "/admin", `/workspaces/${WORKSPACE.id}`, "/course"]) {
		const { router, unmount } = renderApp(path);
		await waitFor(() => expect(router.state.location.pathname).toBe("/acceptable-use"));
		expect(await screen.findByRole("heading", { name: "Acceptable use" })).toBeTruthy();
		expect(await screen.findByText("First rule.")).toBeTruthy();
		expect(document.title).toBe("Acceptable use, Portikus");
		unmount();
	}
	// No workspace is made for an account still behind the gate.
	expect(fetch.mock.calls.some(([url]) => url === "/workspaces")).toBe(false);
});

test("the password gate comes before the acceptable-use gate", async () => {
	stubFetch((url) => {
		if (url === "/auth/me")
			return json(200, {
				...UNACCEPTED,
				mustChangePassword: true,
				localPassword: true,
			});
		return json(403, { code: "PASSWORD_CHANGE_REQUIRED", message: "no" });
	});
	const { router } = renderApp("/acceptable-use");
	await waitFor(() => expect(router.state.location.pathname).toBe("/change-password"));
});

test("I accept sends the version shown and lands on the workspace", async () => {
	let accepted = false;
	const fetch = stubFetch((url, init) => {
		if (url === "/auth/me") return json(200, { ...USER, mustAcceptUse: !accepted });
		if (url === "/me/acceptable-use" && init?.method === "POST") {
			accepted = true;
			return new Response(null, { status: 204 });
		}
		if (url === "/me/acceptable-use") return json(200, STATEMENT);
		if (url === "/workspaces" && init?.method === "POST") return json(201, WORKSPACE);
		return json(200, { projects: [], templates: [] });
	});
	const { router } = renderApp("/acceptable-use");
	await screen.findByText("First rule.");
	fireEvent.click(screen.getByRole("button", { name: "I accept" }));

	await waitFor(() =>
		expect(router.state.location.pathname).toBe(`/workspaces/${WORKSPACE.id}`),
	);
	const post = fetch.mock.calls.find(
		([url, init]) => url === "/me/acceptable-use" && init?.method === "POST",
	);
	expect(JSON.parse(String(post?.[1]?.body))).toEqual({ version: 3 });
});

test("a statement changed meanwhile is shown again, not accepted", async () => {
	let current = STATEMENT;
	stubFetch((url, init) => {
		if (url === "/auth/me") return json(200, UNACCEPTED);
		if (url === "/me/acceptable-use" && init?.method === "POST") {
			current = { text: "A newer rule.", version: 4 };
			return json(409, { code: "ACCEPTABLE_USE_CHANGED", message: "changed" });
		}
		if (url === "/me/acceptable-use") return json(200, current);
		return json(200, {});
	});
	const { router } = renderApp("/acceptable-use");
	await screen.findByText("First rule.");
	fireEvent.click(screen.getByRole("button", { name: "I accept" }));

	expect(await screen.findByText("A newer rule.")).toBeTruthy();
	expect((await screen.findByRole("alert")).textContent).toMatch(/has just changed/);
	expect(router.state.location.pathname).toBe("/acceptable-use");
});

test("Sign out posts to /auth/logout", async () => {
	stubFetch((url) => {
		if (url === "/auth/me") return json(200, UNACCEPTED);
		return json(200, STATEMENT);
	});
	renderApp("/acceptable-use");
	await screen.findByText("First rule.");
	const form = document.querySelector('form[action="/auth/logout"]') as HTMLFormElement;
	const submitted = vi.fn((event: Event) => event.preventDefault());
	form.addEventListener("submit", submitted);
	fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
	expect(form.getAttribute("method")).toBe("post");
	await waitFor(() => expect(submitted).toHaveBeenCalled());
});

test("a gate that closes mid-session sends the open page to the statement", async () => {
	// The administrator had accepted; a new text is saved, so the next request is refused.
	let accepted = true;
	stubFetch((url) => {
		if (url === "/auth/me")
			return json(200, { ...USER, role: "administrator", mustAcceptUse: !accepted });
		if (url === "/me/acceptable-use") return json(200, STATEMENT);
		accepted = false;
		return json(403, { code: "ACCEPTABLE_USE_REQUIRED", message: "no" });
	});
	const { router } = renderApp("/admin");
	await waitFor(() => expect(router.state.location.pathname).toBe("/acceptable-use"));
	expect(await screen.findByText("First rule.")).toBeTruthy();
});
