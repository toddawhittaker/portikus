import type { AdminUser } from "@portikus/contracts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { json, renderApp, stubFetch, USER } from "../test-utils.js";
import { PASSWORD_ONCE_TEXT } from "./DexUserDialogs.js";

/** The Dex user dialogs in the Users view (docs/archive/epics/EPIC-14.md rulings 21, 22, 24). */

afterEach(() => vi.unstubAllGlobals());

const ADMIN = {
	...USER,
	id: "33333333-3333-4333-8333-333333333333",
	displayName: "Carol Admin",
	email: "carol@example.invalid",
	role: "administrator" as const,
};

const NONE = {
	disabled: false,
	archived: false,
	duplicateEmail: false,
	stale: false,
	linked: false,
};

function row(
	id: string,
	displayName: string,
	extra: Partial<AdminUser> = {},
): AdminUser {
	return {
		id,
		displayName,
		email: `${displayName.split(" ")[0]?.toLowerCase()}@example.invalid`,
		role: "student",
		providerRole: "student",
		grantedRole: null,
		disabledAt: null,
		shutdownGraceSeconds: null,
		dexLocal: false,
		preferredUsername: null,
		issuer: "https://login.example.edu/dex",
		lastLoginAt: null,
		markers: NONE,
		workspace: null,
		...extra,
	};
}

const DANA = row("44444444-4444-4444-8444-444444444444", "dana", { dexLocal: true });
const CAROL = row(ADMIN.id, "Carol Admin", {
	role: "administrator",
	providerRole: "administrator",
	dexLocal: true,
});
const SSO = row(USER.id, "Alice Example");

const SHOWN_ONCE = "Abcdefghjk23456789mn";

interface Options {
	dexUsers?: boolean;
	/** An error body for every write. */
	refusal?: { status: number; code: string; message: string };
}

function stub({ dexUsers = true, refusal }: Options = {}) {
	const writes: { url: string; body: unknown }[] = [];
	let users = [DANA, CAROL, SSO];
	stubFetch((url, init) => {
		if (url === "/auth/me") return json(200, ADMIN);
		if (url === "/admin/users") return json(200, { users, dexUsers });
		if (url === "/admin/settings") {
			return json(200, { shutdownGraceSeconds: 600, logLevel: null, updatedAt: null });
		}
		if (init?.method === "POST") {
			writes.push({ url, body: init.body ? JSON.parse(String(init.body)) : null });
			if (refusal) {
				return json(refusal.status, { code: refusal.code, message: refusal.message });
			}
			if (url === "/admin/dex-users") {
				const created = row("55555555-5555-4555-8555-555555555555", "Erin Example", {
					dexLocal: true,
				});
				users = [...users, created];
				return json(200, { user: created, password: SHOWN_ONCE });
			}
			if (url.endsWith("/reset-password")) return json(200, { password: SHOWN_ONCE });
			if (url.endsWith("/remove")) {
				const removed = {
					...DANA,
					dexLocal: false,
					disabledAt: "2026-09-24T00:00:00.000Z",
				};
				users = users.map((user) => (user.id === DANA.id ? removed : user));
				return json(200, removed);
			}
		}
		throw new Error(`unexpected request: ${url}`);
	});
	return writes;
}

async function openRow(name: string) {
	renderApp("/admin");
	fireEvent.click(
		await screen.findByRole("button", {
			name: new RegExp(`^Show details for ${name}, `),
		}),
	);
	return screen.findByRole("region", { name });
}

test("Add user is offered only when the site manages Dex users", async () => {
	stub({ dexUsers: false });
	renderApp("/admin");
	await screen.findByRole("button", { name: /^Show details for dana, / });
	expect(screen.queryByRole("button", { name: "Add user…" })).toBeNull();
});

test("Add user sends the form, then shows the password once", async () => {
	const writes = stub();
	renderApp("/admin");
	const add = await screen.findByRole("button", { name: "Add user…" });
	add.focus();
	fireEvent.click(add);
	const dialog = await screen.findByRole("dialog", { name: "Add user" });
	fireEvent.change(within(dialog).getByLabelText("Name"), {
		target: { value: "Erin Example" },
	});
	fireEvent.change(within(dialog).getByLabelText("Email"), {
		target: { value: "erin@example.edu" },
	});
	fireEvent.change(within(dialog).getByLabelText("Username"), {
		target: { value: "erin" },
	});
	fireEvent.change(within(dialog).getByLabelText("Role"), {
		target: { value: "instructor" },
	});
	fireEvent.click(within(dialog).getByRole("button", { name: "Add user" }));

	const done = await screen.findByRole("dialog", {
		name: "Erin Example added",
		description: PASSWORD_ONCE_TEXT,
	});
	expect(within(done).getByTestId("dex-password").textContent).toBe(SHOWN_ONCE);
	expect(within(done).getByText(PASSWORD_ONCE_TEXT)).toBeDefined();
	expect(writes).toEqual([
		{
			url: "/admin/dex-users",
			body: {
				name: "Erin Example",
				email: "erin@example.edu",
				username: "erin",
				role: "instructor",
			},
		},
	]);

	fireEvent.click(within(done).getByRole("button", { name: "Done" }));
	await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	// The password is gone with the dialog, and focus is back on the button.
	expect(screen.queryByText(SHOWN_ONCE)).toBeNull();
	await waitFor(() => expect(document.activeElement).toBe(add));

	// Opening it again starts with an empty form.
	fireEvent.click(add);
	const again = await screen.findByRole("dialog", { name: "Add user" });
	expect((within(again).getByLabelText("Email") as HTMLInputElement).value).toBe("");
});

test("Add user checks each field before sending and focuses the first bad one", async () => {
	const writes = stub();
	renderApp("/admin");
	fireEvent.click(await screen.findByRole("button", { name: "Add user…" }));
	const dialog = await screen.findByRole("dialog", { name: "Add user" });
	// The field must already be invalid when focus reaches it, so it is announced so.
	const atFocus: (string | null)[] = [];
	dialog.addEventListener("focusin", (e) =>
		atFocus.push((e.target as HTMLElement).getAttribute("aria-invalid")),
	);
	fireEvent.click(within(dialog).getByRole("button", { name: "Add user" }));
	const name = within(dialog).getByLabelText("Name");
	await waitFor(() => expect(document.activeElement).toBe(name));
	expect(atFocus.at(-1)).toBe("true");
	expect(document.getElementById("dex-add-name-err")?.textContent).toBe(
		"Enter a name of 1 to 100 characters.",
	);
	const email = within(dialog).getByLabelText("Email");
	expect(email.getAttribute("aria-invalid")).toBe("true");
	expect(document.getElementById("dex-add-email-err")?.textContent).toBe(
		"Enter an email address.",
	);
	expect(document.getElementById("dex-add-username-err")?.textContent).toMatch(
		/username/,
	);
	expect(within(dialog).queryByRole("alert")).toBeNull();
	// A name of only spaces is still no name.
	fireEvent.change(name, { target: { value: "   " } });
	fireEvent.click(within(dialog).getByRole("button", { name: "Add user" }));
	expect(name.getAttribute("aria-invalid")).toBe("true");
	fireEvent.change(name, { target: { value: "Erin Example" } });
	fireEvent.change(within(dialog).getByLabelText("Email"), {
		target: { value: "erin@example.edu" },
	});
	fireEvent.change(within(dialog).getByLabelText("Username"), {
		target: { value: "has space" },
	});
	fireEvent.click(within(dialog).getByRole("button", { name: "Add user" }));
	const username = within(dialog).getByLabelText("Username");
	await waitFor(() => expect(document.activeElement).toBe(username));
	expect(email.getAttribute("aria-invalid")).toBeNull();
	expect(username.getAttribute("aria-invalid")).toBe("true");
	expect(writes).toEqual([]);
});

test("a refused Add user shows the server's message in the dialog", async () => {
	stub({
		refusal: {
			status: 409,
			code: "DEX_USER_EXISTS",
			message: "A Dex user with this email already exists.",
		},
	});
	renderApp("/admin");
	fireEvent.click(await screen.findByRole("button", { name: "Add user…" }));
	const dialog = await screen.findByRole("dialog", { name: "Add user" });
	fireEvent.change(within(dialog).getByLabelText("Name"), {
		target: { value: "Dana" },
	});
	fireEvent.change(within(dialog).getByLabelText("Email"), {
		target: { value: "dana@example.edu" },
	});
	fireEvent.change(within(dialog).getByLabelText("Username"), {
		target: { value: "dana" },
	});
	fireEvent.click(within(dialog).getByRole("button", { name: "Add user" }));
	expect((await within(dialog).findByRole("alert")).textContent).toBe(
		"A Dex user with this email already exists.",
	);
});

test("Reset password asks first, then shows the new password once", async () => {
	const writes = stub();
	const panel = await openRow("dana");
	const reset = within(panel).getByRole("button", { name: "Reset password for dana" });
	reset.focus();
	fireEvent.click(reset);
	const dialog = await screen.findByRole("dialog", {
		name: "Reset the password for dana?",
	});
	expect(within(dialog).getByText(/signed out everywhere/)).toBeDefined();
	fireEvent.click(within(dialog).getByRole("button", { name: "Reset password" }));
	const shown = await screen.findByRole("dialog", {
		name: "New password for dana",
		description: PASSWORD_ONCE_TEXT,
	});
	expect(within(shown).getByTestId("dex-password").textContent).toBe(SHOWN_ONCE);
	expect(writes.map((w) => w.url)).toEqual([
		`/admin/dex-users/${DANA.id}/reset-password`,
	]);
	fireEvent.click(within(shown).getByRole("button", { name: "Done" }));
	await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	await waitFor(() => expect(document.activeElement).toBe(reset));
});

test("a failed reset shows why in the dialog and shows no password", async () => {
	stub({
		refusal: {
			status: 503,
			code: "DEX_UNAVAILABLE",
			message: "Dex could not be reached. Try again.",
		},
	});
	const panel = await openRow("dana");
	fireEvent.click(
		within(panel).getByRole("button", { name: "Reset password for dana" }),
	);
	const dialog = await screen.findByRole("dialog", {
		name: "Reset the password for dana?",
	});
	fireEvent.click(within(dialog).getByRole("button", { name: "Reset password" }));
	expect((await within(dialog).findByRole("alert")).textContent).toBe(
		"Dex could not be reached. Try again.",
	);
	expect(screen.queryByTestId("dex-password")).toBeNull();
});

test("Remove asks first; afterwards focus goes to the panel heading", async () => {
	const writes = stub();
	const panel = await openRow("dana");
	fireEvent.click(within(panel).getByRole("button", { name: "Remove user dana" }));
	const dialog = await screen.findByRole("alertdialog", { name: "Remove dana?" });
	expect(
		within(dialog).getByText(/The workspace stays for you to archive/),
	).toBeDefined();
	fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
	await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
	expect(writes.map((w) => w.url)).toEqual([`/admin/dex-users/${DANA.id}/remove`]);
	await waitFor(() =>
		expect(
			within(panel).queryByRole("button", { name: "Remove user dana" }),
		).toBeNull(),
	);
	await waitFor(() =>
		expect(document.activeElement).toBe(
			within(panel).getByRole("heading", { name: "dana" }),
		),
	);
});

test("a refused Remove shows the refusal in its dialog", async () => {
	stub({
		refusal: {
			status: 400,
			code: "VALIDATION_FAILED",
			message: "At least one other enabled administrator must remain.",
		},
	});
	const panel = await openRow("dana");
	fireEvent.click(within(panel).getByRole("button", { name: "Remove user dana" }));
	const dialog = await screen.findByRole("alertdialog", { name: "Remove dana?" });
	fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
	expect((await within(dialog).findByRole("alert")).textContent).toBe(
		"At least one other enabled administrator must remain.",
	);
});

test("an administrator's own Remove is off and says why", async () => {
	const writes = stub();
	const panel = await openRow("Carol Admin");
	const remove = within(panel).getByRole("button", { name: "Remove user Carol Admin" });
	expect(remove.getAttribute("aria-disabled")).toBe("true");
	expect(remove.getAttribute("aria-describedby")).toBe(
		within(panel).getByText("You cannot remove your own account.").id,
	);
	fireEvent.click(remove);
	expect(screen.queryByRole("alertdialog")).toBeNull();
	expect(writes).toEqual([]);
});

test("an SSO account has no Dex buttons", async () => {
	stub();
	const panel = await openRow("Alice Example");
	expect(within(panel).queryByRole("button", { name: /^Reset password/ })).toBeNull();
	expect(within(panel).queryByRole("button", { name: /^Remove user/ })).toBeNull();
});

test("an administrator's own Reset password is off and says why", async () => {
	const writes = stub();
	const panel = await openRow("Carol Admin");
	const reset = within(panel).getByRole("button", {
		name: "Reset password for Carol Admin",
	});
	expect(reset.getAttribute("aria-disabled")).toBe("true");
	expect(reset.getAttribute("aria-describedby")).toBe(
		within(panel).getByText("You cannot reset your own password here.").id,
	);
	fireEvent.click(reset);
	expect(screen.queryByRole("dialog")).toBeNull();
	expect(writes).toEqual([]);
});
