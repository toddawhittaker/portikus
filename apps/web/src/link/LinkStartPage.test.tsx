/**
 * The /link/start page, used when the browser blocks the new tab
 * (docs/EPIC-13-1.md, "The flow" step 2). Loading it must not start a link.
 */
import { fireEvent, screen, waitFor } from "@testing-library/react";
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
	vi.stubGlobal("location", { ...window.location, pathname: "/link/start", replace });
	return { posts, replace };
}

test("loading the page posts nothing; Continue starts the link and goes to the SSO sign-in", async () => {
	const { posts, replace } = stubStart(() =>
		json(200, { redirectUrl: "https://sso.example.edu/authorize?x=1" }),
	);
	renderApp("/link/start");

	const go = await screen.findByRole("button", { name: "Continue to SSO sign-in" });
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(posts).toEqual([]);

	fireEvent.click(go);

	await waitFor(() =>
		expect(replace).toHaveBeenCalledWith("https://sso.example.edu/authorize?x=1"),
	);
	expect(posts).toEqual(["/me/links/start"]);
	expect(screen.getByRole("status").textContent).toBe("Opening the SSO sign-in…");
});

test("a refused start is announced on the page", async () => {
	const { replace } = stubStart(() =>
		json(403, {
			code: "FORBIDDEN",
			message: "Open Portikus again from your course to link it.",
		}),
	);
	renderApp("/link/start");

	fireEvent.click(
		await screen.findByRole("button", { name: "Continue to SSO sign-in" }),
	);

	expect((await screen.findByRole("alert")).textContent).toBe(
		"Open Portikus again from your course to link it.",
	);
	expect(screen.getByRole("button", { name: "Back to Portikus" })).toBeTruthy();
	expect(replace).not.toHaveBeenCalled();
});
