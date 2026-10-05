import type { Invitation } from "@portikus/contracts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { json, renderApp, stubFetch, USER } from "../../test-utils.js";
import { NO_FILTERS } from "./filters.js";
import { filterInvitations } from "./Invitations.js";

test("the search and role filters apply to invitations; workspace filters hide them", () => {
	const sam: Invitation = {
		...NINA,
		id: "77777777-7777-4777-8777-777777777777",
		email: "sam@example.edu",
		displayName: "Sam",
		role: "student",
	};
	const all = [NINA, sam];
	expect(filterInvitations(all, NO_FILTERS)).toHaveLength(2);
	expect(filterInvitations(all, { ...NO_FILTERS, text: "NINA" })).toEqual([NINA]);
	expect(filterInvitations(all, { ...NO_FILTERS, role: "student" })).toEqual([sam]);
	expect(filterInvitations(all, { ...NO_FILTERS, state: "running" })).toEqual([]);
	expect(filterInvitations(all, { ...NO_FILTERS, state: "none" })).toHaveLength(2);
	expect(filterInvitations(all, { ...NO_FILTERS, image: "older" })).toEqual([]);
});

/** Invite and Revoke in the Users view (SPEC.md section 24.13). */

afterEach(() => vi.unstubAllGlobals());

const ADMIN = {
	...USER,
	id: "33333333-3333-4333-8333-333333333333",
	displayName: "Carol Admin",
	role: "administrator" as const,
};

const NINA: Invitation = {
	id: "66666666-6666-4666-8666-666666666666",
	email: "nina@example.edu",
	username: null,
	displayName: "Nina Newcomer",
	role: "instructor",
	createdAt: "2026-10-04T00:00:00.000Z",
};

function stub(start: Invitation[] = []) {
	const writes: { url: string; body: unknown }[] = [];
	let invitations = start;
	stubFetch((url, init) => {
		if (url === "/auth/me") return json(200, ADMIN);
		if (url === "/admin/users") return json(200, { users: [], dexUsers: false });
		if (url === "/admin/invitations" && init?.method !== "POST") {
			return json(200, { invitations });
		}
		if (init?.method === "POST") {
			writes.push({ url, body: init.body ? JSON.parse(String(init.body)) : null });
			if (url === "/admin/invitations") {
				invitations = [NINA];
				return json(201, NINA);
			}
			if (url.endsWith("/revoke")) {
				invitations = [];
				return json(200, NINA);
			}
		}
		return json(404, { code: "NOT_FOUND", message: "Not found." });
	});
	return writes;
}

test("Invite sends the form and the invitation shows as waiting", async () => {
	const writes = stub();
	renderApp("/admin");
	fireEvent.click(await screen.findByRole("button", { name: "Invite…" }));
	const dialog = await screen.findByRole("dialog", { name: "Invite someone" });
	fireEvent.change(within(dialog).getByLabelText("Name"), {
		target: { value: "Nina Newcomer" },
	});
	fireEvent.change(within(dialog).getByLabelText("Email"), {
		target: { value: "Nina@Example.edu" },
	});
	fireEvent.change(within(dialog).getByLabelText("Role"), {
		target: { value: "instructor" },
	});
	fireEvent.click(within(dialog).getByRole("button", { name: "Invite" }));

	await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	// No sign-in name: it is left out, and the email is lower-cased.
	expect(writes).toEqual([
		{
			url: "/admin/invitations",
			body: { name: "Nina Newcomer", email: "nina@example.edu", role: "instructor" },
		},
	]);
	// A row at the end of the Users table.
	const table = screen.getByTestId("admin-accounts");
	const row = await within(table).findByTestId("invitation-nina@example.edu");
	expect(within(row).getByText("Invited")).toBeDefined();
	expect(within(row).getByText("Instructor")).toBeDefined();
});

test("Invite focuses the first bad field instead of sending", async () => {
	const writes = stub();
	renderApp("/admin");
	fireEvent.click(await screen.findByRole("button", { name: "Invite…" }));
	const dialog = await screen.findByRole("dialog", { name: "Invite someone" });
	fireEvent.click(within(dialog).getByRole("button", { name: "Invite" }));
	const name = within(dialog).getByLabelText("Name");
	await waitFor(() => expect(document.activeElement).toBe(name));
	expect(name.getAttribute("aria-invalid")).toBe("true");
	expect(writes).toEqual([]);
});

test("Revoke asks first, then removes the waiting row", async () => {
	const writes = stub([NINA]);
	renderApp("/admin");
	fireEvent.click(
		await screen.findByRole("button", {
			name: "Revoke the invitation for Nina Newcomer",
		}),
	);
	const dialog = await screen.findByRole("alertdialog", {
		name: "Revoke the invitation for Nina Newcomer?",
	});
	fireEvent.click(within(dialog).getByRole("button", { name: "Revoke" }));
	await waitFor(() =>
		expect(screen.queryByTestId("invitation-nina@example.edu")).toBeNull(),
	);
	expect(writes.map((w) => w.url)).toEqual([`/admin/invitations/${NINA.id}/revoke`]);
	// The row and its button are gone, so focus lands on the table, not the page.
	await waitFor(() =>
		expect(document.activeElement?.id).toBe("admin-accounts-caption"),
	);
});

test("Cancel on Revoke puts focus back on the Revoke button", async () => {
	stub([NINA]);
	renderApp("/admin");
	const button = await screen.findByRole("button", {
		name: "Revoke the invitation for Nina Newcomer",
	});
	button.focus();
	fireEvent.click(button);
	const dialog = await screen.findByRole("alertdialog", {
		name: "Revoke the invitation for Nina Newcomer?",
	});
	fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
	await waitFor(() => expect(document.activeElement).toBe(button));
	expect(screen.getByTestId("invitation-nina@example.edu")).toBeTruthy();
});

test("a first sign-in without an invitation lands on a page that says what to do", async () => {
	stubFetch((url) => {
		if (url === "/auth/me") return json(401, { code: "UNAUTHORIZED", message: "No" });
		return json(404, { code: "NOT_FOUND", message: "Not found." });
	});
	renderApp("/not-invited");
	expect(
		await screen.findByRole("heading", {
			name: "Your account has not been set up on this site",
		}),
	).toBeDefined();
	expect(screen.getByText("Ask your administrator to invite you.")).toBeDefined();
});
