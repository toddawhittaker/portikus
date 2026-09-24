/**
 * The /link/start page Settings opens in a new tab (docs/EPIC-13-1.md, "The
 * flow" step 2): it starts the link and goes to the SSO sign-in.
 */
import { screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { json, renderApp, stubFetch } from "../test-utils.js";

afterEach(() => vi.unstubAllGlobals());

function stubStart(answer: () => Response) {
	const posts: string[] = [];
	stubFetch((url, init) => {
		if (url === "/me/links/start" && init?.method === "POST") {
			posts.push(url);
			return answer();
		}
		throw new Error(`unexpected request: ${url}`);
	});
	const replace = vi.fn();
	vi.stubGlobal("location", { ...window.location, replace });
	return { posts, replace };
}

test("the start page starts the link once and replaces itself with the SSO sign-in", async () => {
	const { posts, replace } = stubStart(() =>
		json(200, { redirectUrl: "https://sso.example.edu/authorize?x=1" }),
	);
	renderApp("/link/start");

	expect((await screen.findByRole("status")).textContent).toBe(
		"Opening the SSO sign-in…",
	);
	await waitFor(() =>
		expect(replace).toHaveBeenCalledWith("https://sso.example.edu/authorize?x=1"),
	);
	expect(posts).toEqual(["/me/links/start"]);
});

test("a refused start is announced in the new tab", async () => {
	const { replace } = stubStart(() =>
		json(403, {
			code: "FORBIDDEN",
			message: "Open Portikus again from your course to link it.",
		}),
	);
	renderApp("/link/start");

	expect((await screen.findByRole("alert")).textContent).toBe(
		"Open Portikus again from your course to link it.",
	);
	expect(screen.getByRole("button", { name: "Back to Portikus" })).toBeTruthy();
	expect(replace).not.toHaveBeenCalled();
});
