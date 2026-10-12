import type { AdminUser } from "@portikus/contracts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { json, renderApp, stubFetch, USER } from "../test-utils.js";
import { LINK_SENT_TEXT, PASSWORD_ONCE_TEXT } from "./DexUserDialogs.js";
import { isUsersList, settingsBody, usersBody } from "./users/testRows.js";

/** The Dex user dialogs in the Users view (ADR 0028). */

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
	notSignedInYet: false,
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
	/** Account email switched on (SPEC.md section 5.3). */
	accountEmail?: boolean;
	/** An error body for every write. */
	refusal?: { status: number; code: string; message: string };
	/** Changes to dana's row as the list returns it. */
	dana?: Partial<AdminUser>;
}

function stub({ dexUsers = true, accountEmail = false, refusal, dana }: Options = {}) {
	const writes: { url: string; body: unknown }[] = [];
	let users = [{ ...DANA, ...dana }, CAROL, SSO];
	stubFetch((url, init) => {
		if (url === "/auth/me") return json(200, ADMIN);
		if (isUsersList(url)) return usersBody(url, users, dexUsers);
		if (url === "/admin/settings") return settingsBody(accountEmail);
		if (init?.method === "PATCH") {
			const body = JSON.parse(String(init.body));
			writes.push({ url, body });
			const edited = { ...DANA, email: body.email ?? DANA.email };
			users = users.map((user) => (user.id === DANA.id ? edited : user));
			return json(200, {
				user: edited,
				password: body.email && !accountEmail ? SHOWN_ONCE : null,
				emailed: Boolean(body.email && accountEmail),
			});
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
				const emailed = JSON.parse(String(init.body)).sendLink === true;
				return json(200, {
					user: created,
					password: emailed ? null : SHOWN_ONCE,
					emailed,
				});
			}
			if (url.endsWith("/send-reset-link")) return new Response(null, { status: 204 });
			if (url.endsWith("/reset-password")) return json(200, { password: SHOWN_ONCE });
			if (url.endsWith("/reset-second-factor")) return json(200, DANA);
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
	expect(PASSWORD_ONCE_TEXT).toContain(
		"They will choose their own password when they first sign in.",
	);
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
	for (const label of ["Name", "Email", "Username"]) {
		expect(within(dialog).getByLabelText(label).getAttribute("aria-required")).toBe(
			"true",
		);
	}
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

test("Reset two-factor sign-in explains the new setup and asks first", async () => {
	const writes = stub();
	const panel = await openRow("dana");
	fireEvent.click(
		within(panel).getByRole("button", { name: "Reset two-factor sign-in for dana" }),
	);
	const dialog = await screen.findByRole("alertdialog", {
		name: "Reset two-factor sign-in for dana?",
	});
	expect(
		within(dialog).getByText(
			/must set up a new second factor the next time they sign in/,
		),
	).toBeDefined();
	expect(writes).toEqual([]);
	fireEvent.click(
		within(dialog).getByRole("button", { name: "Reset two-factor sign-in" }),
	);
	await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
	expect(writes.map((w) => w.url)).toEqual([
		`/admin/dex-users/${DANA.id}/reset-second-factor`,
	]);
});

test("a refused two-factor reset shows the refusal in its dialog", async () => {
	const message =
		"Only the install administrator can change the install administrator account. Recover it on the host with portikus reset-admin.";
	stub({ refusal: { status: 403, code: "FORBIDDEN", message } });
	const panel = await openRow("dana");
	fireEvent.click(
		within(panel).getByRole("button", { name: "Reset two-factor sign-in for dana" }),
	);
	const dialog = await screen.findByRole("alertdialog", {
		name: "Reset two-factor sign-in for dana?",
	});
	fireEvent.click(
		within(dialog).getByRole("button", { name: "Reset two-factor sign-in" }),
	);
	expect((await within(dialog).findByRole("alert")).textContent).toBe(message);
});

test("an administrator's own two-factor reset is off and points to Settings", async () => {
	const writes = stub();
	const panel = await openRow("Carol Admin");
	const button = within(panel).getByRole("button", {
		name: "Reset two-factor sign-in for Carol Admin",
	});
	expect(button.getAttribute("aria-disabled")).toBe("true");
	expect(button.getAttribute("aria-describedby")).toBe(
		within(panel).getByText("Change your own two-factor sign-in in Settings.").id,
	);
	fireEvent.click(button);
	expect(screen.queryByRole("alertdialog")).toBeNull();
	expect(writes).toEqual([]);
});

test("with account email on, Add user emails a link and shows no password", async () => {
	const writes = stub({ accountEmail: true });
	renderApp("/admin");
	fireEvent.click(await screen.findByRole("button", { name: "Add user…" }));
	const dialog = await screen.findByRole("dialog", { name: "Add user" });
	const box = await within(dialog).findByRole("checkbox", {
		name: "Email them a link to choose their password",
	});
	// Off until ticked, so nobody is emailed by surprise.
	expect((box as HTMLInputElement).checked).toBe(false);
	fireEvent.click(box);
	fireEvent.change(within(dialog).getByLabelText("Name"), {
		target: { value: "Erin Example" },
	});
	fireEvent.change(within(dialog).getByLabelText("Email"), {
		target: { value: "erin@example.edu" },
	});
	fireEvent.change(within(dialog).getByLabelText("Username"), {
		target: { value: "erin" },
	});
	fireEvent.click(within(dialog).getByRole("button", { name: "Add user" }));
	const done = await screen.findByRole("dialog", {
		name: "Erin Example added",
		description: LINK_SENT_TEXT,
	});
	expect(within(done).queryByTestId("dex-password")).toBeNull();
	expect(writes[0]?.body).toMatchObject({ sendLink: true });
});

test("with account email off, Add user offers no link and Send reset link is absent", async () => {
	const writes = stub();
	const panel = await openRow("dana");
	expect(
		within(panel).queryByRole("button", { name: /^Send reset link to/ }),
	).toBeNull();
	fireEvent.click(await screen.findByRole("button", { name: "Add user…" }));
	const dialog = await screen.findByRole("dialog", { name: "Add user" });
	expect(within(dialog).queryByRole("checkbox")).toBeNull();
	expect(writes).toEqual([]);
});

test("Send reset link asks first, then posts and confirms", async () => {
	const writes = stub({ accountEmail: true });
	const panel = await openRow("dana");
	fireEvent.click(
		await within(panel).findByRole("button", { name: "Send reset link to dana" }),
	);
	const dialog = await screen.findByRole("alertdialog", {
		name: "Email dana a reset link?",
	});
	fireEvent.click(within(dialog).getByRole("button", { name: "Send reset link" }));
	await screen.findByText("Reset link sent to dana");
	expect(writes.map((w) => w.url)).toEqual([
		`/admin/dex-users/${DANA.id}/send-reset-link`,
	]);
});

test("Edit sends only the changed email and shows the new password once", async () => {
	const writes = stub();
	const panel = await openRow("dana");
	fireEvent.click(
		within(panel).getByRole("button", { name: "Edit email or username for dana" }),
	);
	const dialog = await screen.findByRole("dialog", { name: "Edit dana" });
	const email = within(dialog).getByLabelText("Email") as HTMLInputElement;
	expect(email.value).toBe(DANA.email);
	fireEvent.change(email, { target: { value: "dana.new@example.edu" } });
	fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
	const done = await screen.findByRole("dialog", { name: "New password for dana" });
	expect(within(done).getByTestId("dex-password").textContent).toBe(SHOWN_ONCE);
	expect(writes).toEqual([
		{ url: `/admin/dex-users/${DANA.id}`, body: { email: "dana.new@example.edu" } },
	]);
});

test("Edit with nothing changed says so and sends nothing", async () => {
	const writes = stub();
	const panel = await openRow("dana");
	fireEvent.click(
		within(panel).getByRole("button", { name: "Edit email or username for dana" }),
	);
	const dialog = await screen.findByRole("dialog", { name: "Edit dana" });
	fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
	await within(dialog).findByText("Change the email or the username first.");
	expect(writes).toEqual([]);
});

test("Edit is not offered on a disabled account", async () => {
	stub({ dana: { disabledAt: "2026-09-24T00:00:00.000Z" } });
	const panel = await openRow("dana");
	await within(panel).findByRole("button", { name: /^Reset password for/ });
	expect(
		within(panel).queryByRole("button", { name: /^Edit email or username/ }),
	).toBeNull();
});

test("Edit and Send reset link are not offered on your own account", async () => {
	stub({ accountEmail: true });
	const panel = await openRow("Carol Admin");
	await within(panel).findByRole("button", { name: /^Reset password for/ });
	expect(
		within(panel).queryByRole("button", { name: /^Edit email or username/ }),
	).toBeNull();
	expect(
		within(panel).queryByRole("button", { name: /^Send reset link to/ }),
	).toBeNull();
});
