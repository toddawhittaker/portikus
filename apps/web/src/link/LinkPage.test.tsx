/**
 * The /link confirmation page (docs/EPIC-13-1.md, "The flow" steps 4 and 5,
 * ruling 18): it names both accounts, confirms, and explains every refusal.
 */
import { LinkError } from "@portikus/contracts";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { json, renderApp, stubFetch } from "../test-utils.js";
import { LINK_ERROR_MESSAGES } from "./LinkPage.js";

afterEach(() => vi.unstubAllGlobals());

const PENDING = {
	course: { displayName: "Sam Student", platformName: "mock-lms" },
	sso: { displayName: "Bob Student", signInName: "bob", email: "bob@example.edu" },
};

function stubLink(confirm: () => Response) {
	const posts: string[] = [];
	stubFetch((url, init) => {
		if (url === "/me/links/pending") return json(200, PENDING);
		if (url === "/me/links/confirm" && init?.method === "POST") {
			posts.push(url);
			return confirm();
		}
		throw new Error(`unexpected request: ${url}`);
	});
	const assign = vi.fn();
	vi.stubGlobal("location", { ...window.location, assign });
	return { posts, assign };
}

/** Collects what this page tells the tab that started the link. */
function listen() {
	const heard: unknown[] = [];
	const channel = new BroadcastChannel("portikus-link");
	channel.onmessage = (event) => heard.push(event.data);
	return heard;
}

test("confirming names both accounts, tells the waiting tab, and closes this one", async () => {
	const { posts, assign } = stubLink(() => json(200, {}));
	const close = vi.fn();
	vi.stubGlobal("close", close);
	const heard = listen();
	renderApp("/link");

	const accounts = await screen.findByTestId("link-accounts");
	expect(accounts.textContent).toContain("Sam Student");
	expect(accounts.textContent).toContain("mock-lms");
	expect(accounts.textContent).toContain("Bob Student");
	expect(accounts.textContent).toContain("bob@example.edu");
	expect(document.title).toBe("Link accounts, Portikus");

	fireEvent.click(screen.getByRole("button", { name: "Link accounts" }));

	expect((await screen.findByTestId("link-done")).textContent).toBe(
		"Linked. You can close this tab.",
	);
	expect(
		screen.getByRole("link", { name: "Go to Portikus" }).getAttribute("href"),
	).toBe("/");
	await waitFor(() => expect(heard).toEqual([{ type: "linked" }]));
	expect(close).toHaveBeenCalled();
	expect(assign).not.toHaveBeenCalled();
	expect(posts).toEqual(["/me/links/confirm"]);
});

test("Cancel tells the waiting tab and leaves without confirming", async () => {
	const { posts, assign } = stubLink(() => json(200, {}));
	const close = vi.fn();
	vi.stubGlobal("close", close);
	const heard = listen();
	renderApp("/link");

	fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

	await waitFor(() => expect(heard).toEqual([{ type: "cancelled" }]));
	expect(close).toHaveBeenCalled();
	// jsdom will not close a window, so the fallback goes home.
	expect(assign).toHaveBeenCalledWith("/");
	expect(posts).toEqual([]);
});

test("a refused confirm is announced with the server's reason", async () => {
	stubLink(() =>
		json(400, {
			code: "VALIDATION_FAILED",
			message: "That SSO account is already linked.",
		}),
	);
	renderApp("/link");

	fireEvent.click(await screen.findByRole("button", { name: "Link accounts" }));

	expect((await screen.findByRole("alert")).textContent).toBe(
		"That SSO account is already linked.",
	);
});

test("a confirm with no pending link left says it expired", async () => {
	stubLink(() => json(404, { code: "NOT_FOUND", message: "Not found" }));
	renderApp("/link");

	fireEvent.click(await screen.findByRole("button", { name: "Link accounts" }));

	expect((await screen.findByRole("alert")).textContent).toBe(
		LINK_ERROR_MESSAGES.expired,
	);
});

test("with nothing pending the page says no link is waiting", async () => {
	stubFetch((url) => {
		if (url === "/me/links/pending")
			return json(404, { code: "NOT_FOUND", message: "no" });
		throw new Error(`unexpected request: ${url}`);
	});
	renderApp("/link");

	expect(
		await screen.findByRole("heading", { name: "No link is waiting" }),
	).toBeTruthy();
	expect(screen.queryByRole("button", { name: "Link accounts" })).toBeNull();
});

for (const code of LinkError.options) {
	test(`the ${code} refusal is explained in plain English`, async () => {
		stubFetch((url) => {
			throw new Error(`unexpected request: ${url}`);
		});
		renderApp(`/link?error=${code}`);

		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toBe(LINK_ERROR_MESSAGES[code]);
		expect(
			screen.getByRole("heading", { name: "Your accounts were not linked" }),
		).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Link accounts" })).toBeNull();
	});
}

test("an unknown error code falls back to the pending link", async () => {
	stubLink(() => json(200, {}));
	renderApp("/link?error=made-up");

	expect(await screen.findByRole("button", { name: "Link accounts" })).toBeTruthy();
});
