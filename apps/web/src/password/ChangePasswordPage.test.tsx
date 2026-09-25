/** The change-password gate in the router (SPEC.md section 5.3). */
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { json, renderApp, stubFetch, USER, WORKSPACE } from "../test-utils.js";

afterEach(() => vi.unstubAllGlobals());

const FLAGGED = {
	...USER,
	displayName: "Local administrator",
	role: "administrator" as const,
	mustChangePassword: true,
	localPassword: true,
};

test("an account that must change its password is sent to the change page from any page", async () => {
	const fetch = stubFetch((url) => {
		if (url === "/auth/me") return json(200, FLAGGED);
		return json(403, { code: "PASSWORD_CHANGE_REQUIRED", message: "no" });
	});

	for (const path of ["/", "/admin", `/workspaces/${WORKSPACE.id}`, "/course"]) {
		const { router, unmount } = renderApp(path);
		await waitFor(() =>
			expect(router.state.location.pathname).toBe("/change-password"),
		);
		expect(
			await screen.findByRole("heading", { name: "Set a new password" }),
		).toBeTruthy();
		expect(document.title).toBe("Set a new password, Portikus");
		unmount();
	}
	expect(fetch.mock.calls.some(([url]) => url === "/workspaces")).toBe(false);
});

test("after a good change the administrator lands on the admin page", async () => {
	let flagged = true;
	stubFetch((url) => {
		if (url === "/auth/me")
			return json(200, { ...FLAGGED, mustChangePassword: flagged });
		if (url === "/me/password") {
			flagged = false;
			return new Response(null, { status: 204 });
		}
		return json(200, {});
	});
	const { router } = renderApp("/change-password");
	fireEvent.change(await screen.findByLabelText("Current password"), {
		target: { value: "one-time-password-x" },
	});
	fireEvent.change(screen.getByLabelText("New password"), {
		target: { value: "correct horse battery staple" },
	});
	fireEvent.change(screen.getByLabelText("New password again"), {
		target: { value: "correct horse battery staple" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Change password" }));

	await waitFor(() => expect(router.state.location.pathname).toBe("/admin"));
	expect(
		await screen.findByText("Password changed. The one-time password no longer works."),
	).toBeTruthy();
});

test("the setup page is gone", async () => {
	stubFetch((url) => {
		if (url === "/auth/me") return json(401, { code: "UNAUTHORIZED", message: "no" });
		return json(404, { code: "NOT_FOUND", message: "Not found." });
	});
	renderApp("/setup");
	expect(await screen.findByText("Not Found")).toBeTruthy();
});
