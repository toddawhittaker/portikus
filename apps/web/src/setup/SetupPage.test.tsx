/**
 * The /setup page (docs/EPIC-14.md rulings 17 and 18): signed in it claims
 * the code; signed out on a standalone Dex site with no administrator it
 * creates the first account; otherwise it asks the person to sign in.
 */
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { json, renderApp, stubFetch, USER } from "../test-utils.js";

afterEach(() => vi.unstubAllGlobals());

function stub(options: {
	signedIn: boolean;
	firstAccount?: boolean;
	post?: () => Response;
}) {
	const posts: { url: string; body: unknown }[] = [];
	stubFetch((url, init) => {
		if (url === "/auth/me") {
			return options.signedIn
				? json(200, USER)
				: json(401, { code: "UNAUTHORIZED", message: "no" });
		}
		if (url === "/setup/state") {
			return json(200, { firstAccount: options.firstAccount ?? false });
		}
		if (init?.method === "POST") {
			posts.push({ url, body: JSON.parse(String(init.body)) });
			return options.post?.() ?? new Response(null, { status: 204 });
		}
		throw new Error(`unexpected request: ${url}`);
	});
	return posts;
}

test("signed in, a good code says so and links to Administration", async () => {
	const posts = stub({ signedIn: true });
	renderApp("/setup");
	fireEvent.change(await screen.findByLabelText("Setup code"), {
		target: { value: "abcd-efgh-jkmn-pqrs" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Become administrator" }));
	const done = await screen.findByTestId("setup-done");
	expect(done.textContent).toBe("You are now an administrator.");
	// Focus moves to the result so a screen reader reads it.
	await waitFor(() => expect(document.activeElement).toBe(done));
	expect(screen.getByRole("link", { name: "Open Administration" })).toBeTruthy();
	expect(posts).toEqual([
		{ url: "/setup/claim", body: { code: "abcd-efgh-jkmn-pqrs" } },
	]);
});

test("signed in, a refused code is announced", async () => {
	stub({
		signedIn: true,
		post: () =>
			json(400, { code: "VALIDATION_FAILED", message: "That code is not valid." }),
	});
	renderApp("/setup");
	fireEvent.change(await screen.findByLabelText("Setup code"), {
		target: { value: "ZZZZ" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Become administrator" }));
	expect((await screen.findByRole("alert")).textContent).toBe(
		"That code is not valid.",
	);
});

test("signed out with no first-account form, it asks the person to sign in", async () => {
	const posts = stub({ signedIn: false, firstAccount: false });
	renderApp("/setup");
	expect(await screen.findByRole("link", { name: "Sign in" })).toBeTruthy();
	expect(screen.queryByLabelText("Setup code")).toBeNull();
	expect(posts).toEqual([]);
});

test("signed out under Dex with no administrator, it creates the first account", async () => {
	const posts = stub({ signedIn: false, firstAccount: true });
	renderApp("/setup");
	const fill = (label: string, value: string) =>
		fireEvent.change(screen.getByLabelText(label), { target: { value } });
	await screen.findByLabelText("Email");
	fill("Email", "owner@example.edu");
	fill("Username", "owner");
	fill("Password", "correct horse battery");
	fill("Password again", "correct horse batterx");
	fill("Setup code", "ABCD-EFGH-JKMN-PQRS");
	const create = screen.getByRole("button", { name: "Create administrator account" });
	fireEvent.click(create);
	// The mismatch belongs to "Password again", which takes focus.
	const again = screen.getByLabelText("Password again");
	expect(again.getAttribute("aria-invalid")).toBe("true");
	expect(
		document.getElementById(String(again.getAttribute("aria-describedby")))
			?.textContent,
	).toBe("The two passwords do not match.");
	expect(document.activeElement).toBe(again);
	expect(screen.queryByRole("alert")).toBeNull();
	expect(posts).toEqual([]);

	fill("Password again", "correct horse battery");
	fireEvent.click(create);
	const done = await screen.findByTestId("setup-done");
	await waitFor(() => expect(document.activeElement).toBe(done));
	expect(posts).toEqual([
		{
			url: "/setup/first-account",
			body: {
				email: "owner@example.edu",
				username: "owner",
				password: "correct horse battery",
				code: "ABCD-EFGH-JKMN-PQRS",
			},
		},
	]);
});

test("a short password is refused before anything is sent", async () => {
	const posts = stub({ signedIn: false, firstAccount: true });
	renderApp("/setup");
	await screen.findByLabelText("Email");
	fireEvent.change(screen.getByLabelText("Email"), {
		target: { value: "o@example.edu" },
	});
	fireEvent.change(screen.getByLabelText("Username"), { target: { value: "o" } });
	fireEvent.change(screen.getByLabelText("Password"), { target: { value: "short" } });
	fireEvent.change(screen.getByLabelText("Password again"), {
		target: { value: "short" },
	});
	fireEvent.change(screen.getByLabelText("Setup code"), { target: { value: "X" } });
	fireEvent.click(screen.getByRole("button", { name: "Create administrator account" }));
	// Each field shows its own error; focus goes to the first one.
	const password = screen.getByLabelText("Password");
	expect(password.getAttribute("aria-invalid")).toBe("true");
	expect(password.getAttribute("aria-describedby")).toContain("setup-password-err");
	expect(document.getElementById("setup-password-err")?.textContent).toBe(
		"Use a password of 12 to 72 characters.",
	);
	expect(document.activeElement).toBe(password);
	expect(posts).toEqual([]);
});
