import type { AdminUser, AdminWorkspaceSummary } from "@portikus/contracts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { json, renderApp, stubFetch } from "../test-utils.js";
import {
	bulkApplies,
	filterAccounts,
	joinNames,
	lastActivity,
	NO_FILTERS,
	timeAgo,
} from "./WorkspacesTab.js";

const NONE = {
	disabled: false,
	archived: false,
	duplicateEmail: false,
	stale: false,
	linked: false,
};

function summary(
	overrides: Partial<AdminWorkspaceSummary> = {},
): AdminWorkspaceSummary {
	return {
		id: "22222222-2222-4222-8222-222222222222",
		label: "alice",
		state: "running",
		desiredState: "running",
		activeConnections: 0,
		lastActiveConnectionAt: null,
		quotaConfig: { homeGiB: 25, dockerGiB: 20 },
		quotaApplied: { homeGiB: 25, dockerGiB: 20 },
		image: { label: "2026.09.9", fingerprint: "abc", current: true },
		archivedAt: null,
		...overrides,
	};
}

function account(
	displayName: string,
	workspace: AdminWorkspaceSummary | null,
	extra: Partial<AdminUser> = {},
): AdminUser {
	return {
		id: `${displayName}-id`,
		displayName,
		email: `${displayName.toLowerCase()}@example.edu`,
		role: "student",
		providerRole: "student",
		grantedRole: null,
		disabledAt: null,
		shutdownGraceSeconds: null,
		preferredUsername: displayName.toLowerCase(),
		issuer: null,
		lastLoginAt: null,
		markers: NONE,
		workspace,
		...extra,
	};
}

const alice = account("Alice", summary());
const bob = account(
	"Bob",
	summary({
		label: "bobby",
		state: "stopped",
		image: { label: "old", fingerprint: "x", current: false },
	}),
);
const carol = account("Carol", null);
const dave = account(
	"Dave",
	summary({ label: "dave", archivedAt: "2026-09-01T00:00:00.000Z" }),
	{
		markers: { ...NONE, archived: true },
	},
);
const all = [alice, bob, carol, dave];

function names(users: AdminUser[]): string[] {
	return users.map((user) => user.displayName);
}

test("archived rows are hidden unless asked for", () => {
	expect(names(filterAccounts(all, NO_FILTERS))).toEqual(["Alice", "Bob", "Carol"]);
	expect(names(filterAccounts(all, { ...NO_FILTERS, showArchived: true }))).toEqual([
		"Alice",
		"Bob",
		"Carol",
		"Dave",
	]);
});

test("the text filter matches name, email, username and workspace label", () => {
	expect(names(filterAccounts(all, { ...NO_FILTERS, text: "BOBBY" }))).toEqual(["Bob"]);
	expect(names(filterAccounts(all, { ...NO_FILTERS, text: "carol@" }))).toEqual([
		"Carol",
	]);
	expect(names(filterAccounts(all, { ...NO_FILTERS, text: "  " }))).toEqual([
		"Alice",
		"Bob",
		"Carol",
	]);
});

test("the state filter picks a state, or accounts with no workspace", () => {
	expect(names(filterAccounts(all, { ...NO_FILTERS, state: "stopped" }))).toEqual([
		"Bob",
	]);
	expect(names(filterAccounts(all, { ...NO_FILTERS, state: "none" }))).toEqual([
		"Carol",
	]);
});

test("the image filter picks current or older", () => {
	expect(names(filterAccounts(all, { ...NO_FILTERS, image: "current" }))).toEqual([
		"Alice",
	]);
	expect(names(filterAccounts(all, { ...NO_FILTERS, image: "older" }))).toEqual([
		"Bob",
	]);
});

test("last activity is Now while connected, otherwise the time since", () => {
	const now = Date.parse("2026-09-22T12:00:00.000Z");
	expect(lastActivity(summary({ activeConnections: 2 }), now)).toBe("Now");
	expect(
		lastActivity(summary({ lastActiveConnectionAt: "2026-09-22T11:56:00.000Z" }), now),
	).toBe("4 min ago");
	expect(timeAgo("2026-09-22T09:00:00.000Z", now)).toBe("3 h ago");
	expect(timeAgo("2026-09-21T11:00:00.000Z", now)).toBe("1 day ago");
	expect(timeAgo("2026-08-22T11:00:00.000Z", now)).toBe("31 days ago");
	expect(timeAgo("2026-09-22T11:59:40.000Z", now)).toBe("Just now");
	expect(timeAgo(null, now)).toBe("—");
});

test("the text filter also matches the username and the source", () => {
	const course = account("Sam", null, {
		preferredUsername: "sstudent",
		issuer: "lti:https://canvas.example.edu",
	});
	const users = [alice, course];
	expect(names(filterAccounts(users, { ...NO_FILTERS, text: "sstud" }))).toEqual([
		"Sam",
	]);
	expect(names(filterAccounts(users, { ...NO_FILTERS, text: "canvas" }))).toEqual([
		"Sam",
	]);
	expect(names(filterAccounts(users, { ...NO_FILTERS, text: "sso" }))).toEqual([
		"Alice",
	]);
});

test("the role filter keeps one effective role", () => {
	const admin = account("Ann", null, { role: "administrator" });
	const teacher = account("Ian", null, { role: "instructor" });
	const users = [alice, admin, teacher];
	expect(
		names(filterAccounts(users, { ...NO_FILTERS, role: "administrator" })),
	).toEqual(["Ann"]);
	expect(names(filterAccounts(users, { ...NO_FILTERS, role: "instructor" }))).toEqual([
		"Ian",
	]);
	expect(names(filterAccounts(users, { ...NO_FILTERS, role: "student" }))).toEqual([
		"Alice",
	]);
});

test("a bulk action applies only where it changes something", () => {
	const off = account("Off", null, { disabledAt: "2026-09-01T00:00:00.000Z" });
	expect(bulkApplies("disable", alice, "me")).toBe(true);
	expect(bulkApplies("disable", alice, alice.id)).toBe(false);
	expect(bulkApplies("disable", off, "me")).toBe(false);
	expect(bulkApplies("enable", off, "me")).toBe(true);
	expect(bulkApplies("archive", alice, "me")).toBe(true);
	expect(bulkApplies("archive", carol, "me")).toBe(false);
	expect(bulkApplies("archive", dave, "me")).toBe(false);
	expect(bulkApplies("unarchive", dave, "me")).toBe(true);
	expect(bulkApplies("unarchive", alice, "me")).toBe(false);
	expect(joinNames(["A"])).toBe("A");
	expect(joinNames(["A", "B", "C"])).toBe("A, B and C");
});

// Rendered tests: rows need real ids to pass the contract.
function uuid(n: number): string {
	return `0000000${n}-0000-4000-8000-000000000000`;
}

const ADMIN_ME = {
	id: uuid(9),
	email: "carol@example.invalid",
	displayName: "Carol Admin",
	role: "administrator" as const,
};

function listed(
	n: number,
	displayName: string,
	extra: Partial<AdminUser> = {},
): AdminUser {
	return account(displayName, null, { id: uuid(n), ...extra });
}

const ROWS = [
	listed(1, "Alice Example", {
		workspace: summary({ id: uuid(5), label: "alice" }),
		issuer: "https://login.example.edu",
	}),
	listed(2, "Bob Student", {
		workspace: summary({ id: uuid(6), label: "bob" }),
		issuer: "https://login.example.edu",
	}),
	listed(3, "Sam Course", { issuer: "lti:https://canvas.example.edu" }),
	listed(9, "Carol Admin", { role: "administrator", providerRole: "administrator" }),
	listed(4, "Gina Granted", {
		role: "administrator",
		grantedRole: "administrator",
		disabledAt: "2026-09-01T00:00:00.000Z",
		markers: { ...NONE, disabled: true },
	}),
];

/** Answers the list; POSTs land in `writes`, and a URL in `refuse` answers 400. */
function stubUsers(refuse: Record<string, string> = {}) {
	const writes: string[] = [];
	stubFetch((url, init) => {
		if (url === "/auth/me") return json(200, ADMIN_ME);
		if (url === "/admin/users") return json(200, { users: ROWS });
		if (url === "/admin/settings") {
			return json(200, { shutdownGraceSeconds: 600, logLevel: null, updatedAt: null });
		}
		if (init?.method === "POST") {
			writes.push(url);
			const message = refuse[url];
			if (message) return json(400, { code: "VALIDATION_FAILED", message });
			return json(204, null);
		}
		throw new Error(`unexpected request: ${url}`);
	});
	return writes;
}

afterEach(() => vi.unstubAllGlobals());

async function openTable() {
	renderApp("/admin");
	await screen.findByTestId(`account-row-${uuid(1)}`);
}

test("the table shows each account's role label and source", async () => {
	stubUsers();
	await openTable();
	expect(screen.getByTestId(`account-role-${uuid(1)}`).textContent).toBe("Student");
	expect(screen.getByTestId(`account-role-${uuid(9)}`).textContent).toBe(
		"Administrator (from SSO)",
	);
	expect(screen.getByTestId(`account-role-${uuid(4)}`).textContent).toBe(
		"Administrator (granted)",
	);
	expect(screen.getByTestId(`account-source-${uuid(1)}`).textContent).toBe("SSO");
	expect(screen.getByTestId(`account-source-${uuid(1)}`).title).toBe(
		"https://login.example.edu",
	);
	expect(screen.getByTestId(`account-source-${uuid(3)}`).textContent).toBe(
		"Course: canvas.example.edu",
	);
	expect(screen.getByRole("columnheader", { name: "Source" })).toBeDefined();
	expect(screen.queryByRole("columnheader", { name: "Issuer" })).toBeNull();
	// Badges in cells are not live regions; only the count and the bulk result are.
	expect(screen.getAllByRole("status").map((node) => node.dataset.testid)).toEqual([
		"admin-row-count",
		"bulk-result",
	]);
});

test("search and the role filter narrow the rendered rows", async () => {
	stubUsers();
	await openTable();
	fireEvent.change(screen.getByLabelText("Search"), { target: { value: "canvas" } });
	expect(screen.getByTestId("admin-row-count").textContent).toBe("Showing 1 of 5");
	expect(screen.getByTestId(`account-row-${uuid(3)}`)).toBeDefined();
	fireEvent.change(screen.getByLabelText("Search"), { target: { value: "" } });
	fireEvent.change(screen.getByLabelText("Role"), {
		target: { value: "administrator" },
	});
	expect(screen.getByTestId("admin-row-count").textContent).toBe("Showing 2 of 5");
});

test("select all ticks every shown row and each box is named by the account", async () => {
	stubUsers();
	await openTable();
	const all = screen.getByRole("checkbox", { name: "Select all shown accounts" });
	fireEvent.click(all);
	for (const row of ROWS) {
		const box = screen.getByRole("checkbox", {
			name: `Select ${row.displayName}`,
		}) as HTMLInputElement;
		expect(box.checked).toBe(true);
	}
	const bar = screen.getByTestId("bulk-actions");
	expect(within(bar).getByText("5 selected")).toBeDefined();
	expect(
		within(bar)
			.getAllByRole("button")
			.map((b) => b.textContent),
	).toEqual(["Disable…", "Enable…", "Archive workspace…"]);
	fireEvent.click(all);
	expect(screen.queryByTestId("bulk-actions")).toBeNull();
});

test("only the actions that apply to the ticked rows are offered", async () => {
	stubUsers();
	await openTable();
	fireEvent.click(screen.getByRole("checkbox", { name: "Select Gina Granted" }));
	const bar = screen.getByTestId("bulk-actions");
	expect(
		within(bar)
			.getAllByRole("button")
			.map((b) => b.textContent),
	).toEqual(["Enable…"]);
	// Nobody disables themselves.
	fireEvent.click(screen.getByRole("checkbox", { name: "Select Gina Granted" }));
	fireEvent.click(screen.getByRole("checkbox", { name: "Select Carol Admin" }));
	expect(within(screen.getByTestId("bulk-actions")).queryAllByRole("button")).toEqual(
		[],
	);
});

test("bulk disable names every row, calls each row's route, and names the failures", async () => {
	const writes = stubUsers({
		[`/admin/users/${uuid(2)}/disable`]: "Bob cannot be disabled right now.",
	});
	await openTable();
	fireEvent.click(screen.getByRole("checkbox", { name: "Select Alice Example" }));
	fireEvent.click(screen.getByRole("checkbox", { name: "Select Bob Student" }));
	fireEvent.click(screen.getByRole("checkbox", { name: "Select Sam Course" }));
	fireEvent.click(screen.getByTestId("bulk-disable"));

	const dialog = await screen.findByRole("alertdialog", {
		name: "Disable 3 accounts?",
	});
	expect(within(dialog).getByTestId("bulk-dialog-names").textContent).toBe(
		"Alice Example, Bob Student and Sam Course.",
	);
	fireEvent.click(within(dialog).getByRole("button", { name: "Disable" }));

	await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
	expect(writes).toEqual([
		`/admin/users/${uuid(1)}/disable`,
		`/admin/users/${uuid(2)}/disable`,
		`/admin/users/${uuid(3)}/disable`,
	]);
	const result = screen.getByTestId("bulk-result");
	expect(result.textContent).toContain("Disabled Alice Example and Sam Course.");
	expect(result.textContent).toContain(
		"Could not disable Bob Student: Bob cannot be disabled right now.",
	);
	expect(screen.queryByTestId("bulk-actions")).toBeNull();
	// The bar and dialog are gone, so focus lands on the summary.
	await waitFor(() => expect(document.activeElement).toBe(result));
});

test("a bulk run refetches the list once, not once per row", async () => {
	stubUsers();
	await openTable();
	const listCalls = () =>
		vi
			.mocked(globalThis.fetch)
			.mock.calls.filter(([url]) => String(url) === "/admin/users").length;
	const before = listCalls();
	for (const name of ["Alice Example", "Bob Student", "Sam Course"]) {
		fireEvent.click(screen.getByRole("checkbox", { name: `Select ${name}` }));
	}
	fireEvent.click(screen.getByTestId("bulk-disable"));
	const dialog = await screen.findByRole("alertdialog");
	fireEvent.click(within(dialog).getByRole("button", { name: "Disable" }));
	await waitFor(() =>
		expect(screen.getByTestId("bulk-result").textContent).not.toBe(""),
	);
	await waitFor(() => expect(listCalls()).toBe(before + 1));
});

test("select all shows a dash when some rows are ticked, and the count is announced", async () => {
	stubUsers();
	await openTable();
	const all = screen.getByRole("checkbox", {
		name: "Select all shown accounts",
	}) as HTMLInputElement;
	expect(all.indeterminate).toBe(false);
	fireEvent.click(screen.getByRole("checkbox", { name: "Select Alice Example" }));
	expect(all.indeterminate).toBe(true);
	const count = screen.getByTestId("bulk-count");
	expect(count.getAttribute("aria-live")).toBe("polite");
	expect(count.textContent).toBe("1 selected");
	fireEvent.click(all);
	expect(all.indeterminate).toBe(false);
	expect(count.textContent).toBe("5 selected");
});

test("bulk archive calls the workspace route only for rows that have a workspace", async () => {
	const writes = stubUsers();
	await openTable();
	fireEvent.click(screen.getByRole("checkbox", { name: "Select Alice Example" }));
	fireEvent.click(screen.getByRole("checkbox", { name: "Select Sam Course" }));
	fireEvent.click(screen.getByTestId("bulk-archive"));
	const dialog = await screen.findByRole("alertdialog", {
		name: "Archive the workspaces of 1 account?",
	});
	expect(within(dialog).getByTestId("bulk-dialog-names").textContent).toBe(
		"Alice Example.",
	);
	fireEvent.click(within(dialog).getByRole("button", { name: "Archive" }));
	await waitFor(() =>
		expect(screen.getByTestId("bulk-result").textContent).toBe(
			"Archived the workspace of Alice Example.",
		),
	);
	expect(writes).toEqual([`/admin/workspaces/${uuid(5)}/archive`]);
});
