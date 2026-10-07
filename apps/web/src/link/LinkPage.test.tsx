/**
 * The /link confirmation page (ADR 0026): it names both accounts, confirms, and explains every refusal.
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
	secondFactor: null,
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
	vi.stubGlobal("location", { ...window.location, pathname: "/link", assign });
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

test("the status line stays mounted and empty until it announces the link in progress", async () => {
	let answer: (response: Response) => void = () => {};
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === "/me/links/pending") return json(200, PENDING);
			if (url === "/me/links/confirm") {
				return new Promise<Response>((resolve) => {
					answer = resolve;
				});
			}
			throw new Error(`unexpected request: ${url}`);
		}),
	);
	vi.stubGlobal("close", vi.fn());
	renderApp("/link");

	const status = await screen.findByTestId("link-status");
	expect(status.getAttribute("role")).toBe("status");
	// Empty, it adds no text node, so `:empty` takes it out of the flow and its gap.
	expect(status.childNodes).toHaveLength(0);
	expect(status.className).toContain("empty:absolute");

	fireEvent.click(screen.getByRole("button", { name: "Link accounts" }));
	await waitFor(() => expect(status.textContent).toBe("Linking your accounts…"));
	expect(screen.getByTestId("link-status")).toBe(status);

	answer(json(200, {}));
	await screen.findByTestId("link-done");
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

test("a local-password account types its two-step code, and it is sent with the confirm", async () => {
	const bodies: unknown[] = [];
	stubFetch((url, init) => {
		if (url === "/me/links/pending")
			return json(200, { ...PENDING, secondFactor: "verify" });
		if (url === "/me/links/confirm") {
			bodies.push(JSON.parse(String(init?.body)));
			return json(200, {});
		}
		throw new Error(`unexpected request: ${url}`);
	});
	vi.stubGlobal("close", vi.fn());
	renderApp("/link");

	const field = await screen.findByLabelText("Two-step sign-in code");
	fireEvent.change(field, { target: { value: " 123456 " } });
	fireEvent.click(screen.getByRole("button", { name: "Link accounts" }));

	await screen.findByTestId("link-done");
	expect(bodies).toEqual([{ code: "123456" }]);
});

test("a local-password account with no two-step sign-in is told to set it up, with no Link button", async () => {
	stubFetch((url) => {
		if (url === "/me/links/pending")
			return json(200, { ...PENDING, secondFactor: "enrol" });
		throw new Error(`unexpected request: ${url}`);
	});
	renderApp("/link");

	expect((await screen.findByRole("alert")).textContent).toContain(
		"set up two-step sign-in",
	);
	expect(screen.queryByRole("button", { name: "Link accounts" })).toBeNull();
	expect(screen.queryByLabelText("Two-step sign-in code")).toBeNull();
});

function stubVerify(confirm: () => Response) {
	stubFetch((url) => {
		if (url === "/me/links/pending")
			return json(200, { ...PENDING, secondFactor: "verify" });
		if (url === "/me/links/confirm") return confirm();
		throw new Error(`unexpected request: ${url}`);
	});
}

test("a wrong two-step code marks the field invalid, describes it with the reason, and focuses it", async () => {
	let answer = () =>
		json(400, { code: "VALIDATION_FAILED", message: "That code did not work." });
	stubVerify(() => answer());
	vi.stubGlobal("close", vi.fn());
	renderApp("/link");

	const field = await screen.findByLabelText("Two-step sign-in code");
	const confirm = screen.getByRole("button", { name: "Link accounts" });
	confirm.focus();
	fireEvent.click(confirm);

	await waitFor(() => expect(field.getAttribute("aria-invalid")).toBe("true"));
	expect(document.getElementById("link-code-err")?.textContent).toBe(
		"That code did not work.",
	);
	expect((field.getAttribute("aria-describedby") ?? "").split(" ")).toContain(
		"link-code-err",
	);
	expect(document.activeElement).toBe(field);
	// The reason is said once, by the field, not again in a separate alert.
	expect(screen.queryByTestId("link-error")).toBeNull();

	// A second attempt that works leaves no stale error behind.
	answer = () => json(200, {});
	fireEvent.change(field, { target: { value: "123456" } });
	fireEvent.click(screen.getByRole("button", { name: "Link accounts" }));
	await screen.findByTestId("link-done");
});

test("an expired link at the code step is an alert, not a field error", async () => {
	stubVerify(() => json(404, { code: "NOT_FOUND", message: "Not found" }));
	renderApp("/link");

	const field = await screen.findByLabelText("Two-step sign-in code");
	fireEvent.click(screen.getByRole("button", { name: "Link accounts" }));

	expect((await screen.findByRole("alert")).textContent).toBe(
		LINK_ERROR_MESSAGES.expired,
	);
	expect(field.getAttribute("aria-invalid")).toBeNull();
});
