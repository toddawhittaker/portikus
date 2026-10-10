import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ApiError } from "../api/request.js";
import { json, renderApp, stubFetch } from "../test-utils.js";
import {
	bulkApplies,
	bulkOutcome,
	olderImageTargets,
	rebuildTitle,
	rebuildWarning,
} from "./users/BulkActions.js";
import {
	activityText,
	isFiltered,
	NO_FILTERS,
	usersQueryString,
} from "./users/filters.js";
import { DEFAULT_ACCOUNT_SORT } from "./users/sort.js";
import {
	ADMIN_ME,
	account,
	isUsersList,
	listed,
	NONE,
	openTable,
	ROWS,
	stubUsers,
	summary,
	usersBody,
	uuid,
} from "./users/testRows.js";

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
test("activity is Now with the connection count while connected, otherwise the time since", () => {
	const now = Date.parse("2026-09-22T12:00:00.000Z");
	expect(activityText(summary({ activeConnections: 2 }), now)).toBe(
		"Now, 2 connections",
	);
	expect(activityText(summary({ activeConnections: 1 }), now)).toBe(
		"Now, 1 connection",
	);
	expect(
		activityText(summary({ lastActiveConnectionAt: "2026-09-22T11:56:00.000Z" }), now),
	).toBe("4 minutes ago");
	expect(activityText(summary(), now)).toBe("—");
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
});

afterEach(() => vi.unstubAllGlobals());

test("any filter away from its default counts as filtering", () => {
	expect(isFiltered(NO_FILTERS)).toBe(false);
	expect(isFiltered({ ...NO_FILTERS, text: "   " })).toBe(false);
	expect(isFiltered({ ...NO_FILTERS, text: "ada" })).toBe(true);
	expect(isFiltered({ ...NO_FILTERS, role: "student" })).toBe(true);
	expect(isFiltered({ ...NO_FILTERS, state: "none" })).toBe(true);
	expect(isFiltered({ ...NO_FILTERS, image: "older" })).toBe(true);
	expect(isFiltered({ ...NO_FILTERS, showArchived: true })).toBe(true);
});

test("the table has six columns: selection, Account, Role, Workspace, Activity and actions", async () => {
	stubUsers();
	await openTable();
	const table = screen.getByTestId("admin-accounts");
	expect(
		within(table)
			.getAllByRole("columnheader")
			.map((th) => th.textContent),
	).toEqual([
		"Select all shown accounts",
		"Account",
		"Role",
		"Workspace",
		"Activity",
		"Actions",
	]);
	expect(screen.getByTestId(`account-activity-${uuid(1)}`).textContent).toBe(
		"Now, 2 connections",
	);
	expect(screen.getByTestId(`account-activity-${uuid(2)}`).textContent).toBe("—");
	// No workspace, no activity.
	expect(screen.getByTestId(`account-activity-${uuid(3)}`).textContent).toBe("—");
});

test("the Account cell is the name, then the email or else the username", async () => {
	stubUsers();
	await openTable();
	const alice = screen.getByTestId(`account-name-${uuid(1)}`);
	expect(within(alice).getByRole("button").textContent).toBe("Alice Example");
	expect(screen.getByTestId(`account-contact-${uuid(1)}`).textContent).toBe(
		"alice example@example.edu",
	);
	expect(screen.getByTestId(`account-contact-${uuid(3)}`).textContent).toBe("sam7");
	// The markers sit with the name, in a wrapping row of their own.
	expect(
		within(screen.getByTestId(`account-name-${uuid(4)}`)).getByText("Disabled"),
	).toBeDefined();
});

test("only an out-of-date image shows the Old image tag, in the Workspace cell", async () => {
	stubUsers();
	await openTable();
	const older = screen.getByTestId(`account-image-${uuid(2)}`);
	expect(older.textContent).toBe("Old image");
	expect(older.className).toBe("pk-tag pk-tag--warning");
	expect(older.title).toBe("2026.09.8 · older");
	// Under the state badge, in the same cell as the workspace label.
	expect(older.closest("td")?.textContent).toContain("bob");
	expect(screen.queryByTestId(`account-image-${uuid(1)}`)).toBeNull();
	expect(screen.queryByTestId(`account-image-${uuid(3)}`)).toBeNull();
});

test("the heading row carries the account count", async () => {
	stubUsers();
	await openTable();
	const heading = screen.getByRole("heading", { level: 2, name: "Users" });
	expect(heading.parentElement?.textContent).toContain("5 accounts");
});

test("the table shows each account's role label", async () => {
	stubUsers();
	await openTable();
	expect(screen.getByTestId(`account-role-${uuid(1)}`).textContent).toBe("Student");
	expect(screen.getByTestId(`account-role-${uuid(9)}`).textContent).toBe(
		"Administrator (from SSO)",
	);
	expect(screen.getByTestId(`account-role-${uuid(4)}`).textContent).toBe(
		"Administrator (granted)",
	);
	// Badges in cells are not live regions; only the header's open-workspace
	// status, the count, the bulk result and the sort announcement are.
	expect(screen.getAllByRole("status").map((node) => node.dataset.testid)).toEqual([
		"open-my-workspace-status",
		"admin-row-count",
		"bulk-result",
		"admin-sort-announce",
		"admin-page-announce",
	]);
});

test("search and the role filter narrow the rendered rows", async () => {
	stubUsers();
	await openTable();
	// Nothing filtered and nothing hidden: the heading's count says it all (N4).
	expect(screen.getByTestId("admin-row-count").textContent).toBe("");
	fireEvent.change(screen.getByLabelText("Search"), { target: { value: "canvas" } });
	await waitFor(() =>
		expect(screen.getByTestId("admin-row-count").textContent).toBe("Showing 1 of 1"),
	);
	expect(screen.getByTestId(`account-row-${uuid(3)}`)).toBeDefined();
	fireEvent.change(screen.getByLabelText("Search"), { target: { value: "" } });
	fireEvent.change(screen.getByLabelText("Role"), {
		target: { value: "administrator" },
	});
	await waitFor(() =>
		expect(screen.getByTestId("admin-row-count").textContent).toBe("Showing 2 of 2"),
	);
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
	).toEqual(["Disable…", "Enable…", "Archive workspace…", "Rebuild workspace…"]);
	fireEvent.click(all);
	expect(screen.queryByTestId("bulk-actions")).toBeNull();
});

test("the toolbar row holds the count or the bulk actions, and is always there", async () => {
	stubUsers();
	await openTable();
	const toolbar = screen.getByTestId("admin-table-toolbar");
	// Before anything is ticked, the row says what it is for.
	expect(within(toolbar).getByTestId("bulk-hint").textContent).toBe(
		"Select accounts to act on several at once.",
	);
	fireEvent.change(screen.getByLabelText("Role"), { target: { value: "student" } });
	await waitFor(() =>
		expect(screen.getByTestId("admin-row-count").textContent).toBe("Showing 3 of 3"),
	);
	fireEvent.click(screen.getByRole("checkbox", { name: "Select Alice Example" }));
	// The same row now holds the actions, and the count gives way to them.
	expect(screen.getByTestId("admin-table-toolbar")).toBe(toolbar);
	expect(within(toolbar).getByTestId("bulk-actions")).toBeDefined();
	expect(screen.getByTestId("admin-row-count").textContent).toBe("");
	expect(within(toolbar).queryByTestId("bulk-hint")).toBeNull();
	fireEvent.click(screen.getByRole("checkbox", { name: "Select Alice Example" }));
	expect(screen.getByTestId("admin-row-count").textContent).toBe("Showing 3 of 3");
});

test("bulk Enable is confirmed without the danger styling; Disable keeps it", async () => {
	stubUsers();
	await openTable();
	fireEvent.click(screen.getByRole("checkbox", { name: "Select Gina Granted" }));
	fireEvent.click(screen.getByTestId("bulk-enable"));
	const enable = await screen.findByRole("alertdialog", { name: "Enable 1 account?" });
	expect(
		within(enable).getByRole("button", { name: "Enable" }).className,
	).not.toContain("bg-status-danger");
	fireEvent.click(within(enable).getByRole("button", { name: "Cancel" }));
	await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
	fireEvent.click(screen.getByRole("checkbox", { name: "Select Gina Granted" }));
	fireEvent.click(screen.getByRole("checkbox", { name: "Select Alice Example" }));
	fireEvent.click(screen.getByTestId("bulk-disable"));
	const disable = await screen.findByRole("alertdialog", {
		name: "Disable 1 account?",
	});
	expect(within(disable).getByRole("button", { name: "Disable" }).className).toContain(
		"bg-status-danger",
	);
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
			.mock.calls.filter(([url]) => String(url).includes("limit=")).length;
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

test("a throttled or memory-flagged workspace carries its tags beside the name", async () => {
	const throttled = listed(1, "Alice Example", {
		workspace: summary({
			id: uuid(5),
			cpuThrottle: {
				at: "2026-09-25T12:00:00.000Z",
				thresholdPercent: 80,
				windowMinutes: 30,
				sharePercent: 25,
				averagePercent: 97,
				allowance: "100ms/100ms",
			},
			memoryFlag: {
				at: "2026-09-25T12:00:00.000Z",
				averagePercent: 93,
				thresholdPercent: 90,
				windowMinutes: 30,
			},
		}),
	});
	stubFetch((url) => {
		if (url === "/auth/me") return json(200, ADMIN_ME);
		if (isUsersList(url)) {
			return usersBody(url, [throttled, ROWS[1]], false);
		}
		throw new Error(`unexpected request: ${url}`);
	});
	await openTable();
	const row = screen.getByTestId(`account-row-${uuid(1)}`);
	expect(row.dataset.markers).toBe("Throttled,High memory");
	expect(within(row).getByText("Throttled")).toBeDefined();
	expect(within(row).getByText("High memory")).toBeDefined();
	expect(screen.getByTestId(`account-row-${uuid(2)}`).dataset.markers).toBe("");
});

test("an address naming a user opens that account's panel", async () => {
	stubUsers();
	renderApp(`/admin/users?user=${uuid(2)}`);
	expect(await screen.findByRole("region", { name: "Bob Student" })).toBeDefined();
});

test("bulk Rebuild targets every unarchived workspace", () => {
	expect(bulkApplies("rebuild", alice, "me")).toBe(true);
	expect(bulkApplies("rebuild", carol, "me")).toBe(false);
	expect(bulkApplies("rebuild", dave, "me")).toBe(false);
	// An administrator may rebuild their own workspace.
	expect(bulkApplies("rebuild", alice, alice.id)).toBe(true);
});

test("the older-image shortcut takes only unarchived rows on an older image", () => {
	const archivedOld = account(
		"Old",
		summary({
			archivedAt: "2026-09-01T00:00:00.000Z",
			image: { label: "old", fingerprint: "x", current: false },
		}),
	);
	expect(olderImageTargets([alice, bob, carol, dave, archivedOld])).toEqual([bob]);
});

test("a 409 is skipped and any other error is a failure", () => {
	expect(bulkOutcome(new ApiError(409, "pending", "OPERATION_PENDING"))).toBe(
		"skipped",
	);
	expect(bulkOutcome(new ApiError(409, "busy", "OPERATION_IN_PROGRESS"))).toBe(
		"skipped",
	);
	expect(bulkOutcome(new ApiError(404, "gone", "WORKSPACE_NOT_FOUND"))).toBe("failed");
	expect(bulkOutcome(new Error("network"))).toBe("failed");
});

test("the Rebuild dialog counts workspaces, keeps Docker, and names who restarts", () => {
	expect(rebuildTitle(1)).toBe("Rebuild 1 workspace?");
	expect(rebuildTitle(2)).toBe("Rebuild 2 workspaces?");
	const withRunning = rebuildWarning([alice, bob], false);
	expect(withRunning[0]).toBe("Alice and Bob.");
	expect(withRunning[1]).toContain("sudo apt are lost");
	expect(withRunning[1]).toContain("so do Docker images and volumes");
	expect(withRunning[2]).toBe("Alice is running and will restart.");
	const stoppedOnly = rebuildWarning([bob], true);
	expect(stoppedOnly).toHaveLength(2);
	expect(stoppedOnly[1]).toContain("Docker images and volumes are removed");
});

test("bulk Rebuild posts each workspace in turn and reports done and skipped", async () => {
	const posts: { url: string; body: unknown }[] = [];
	stubFetch((url, init) => {
		if (url === "/auth/me") return json(200, ADMIN_ME);
		if (isUsersList(url)) return usersBody(url, ROWS, false);
		if (init?.method === "POST") {
			posts.push({ url, body: JSON.parse(String(init.body)) });
			if (url.includes(uuid(6))) {
				return json(409, { code: "OPERATION_PENDING", message: "waiting" });
			}
			return json(202, { ok: true });
		}
		throw new Error(`unexpected request: ${url}`);
	});
	await openTable();
	fireEvent.click(screen.getByRole("checkbox", { name: "Select Alice Example" }));
	fireEvent.click(screen.getByRole("checkbox", { name: "Select Bob Student" }));
	fireEvent.click(screen.getByRole("checkbox", { name: "Select Sam Course" }));
	fireEvent.click(screen.getByTestId("bulk-rebuild"));

	const dialog = await screen.findByRole("alertdialog", {
		name: "Rebuild 2 workspaces?",
	});
	const reset = within(dialog).getByRole("checkbox", {
		name: "Also reset Docker",
	}) as HTMLInputElement;
	expect(reset.checked).toBe(false);
	fireEvent.click(within(dialog).getByRole("button", { name: "Rebuild" }));

	await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
	expect(posts).toEqual([
		{ url: `/admin/workspaces/${uuid(5)}/rebuild`, body: { resetDocker: false } },
		{ url: `/admin/workspaces/${uuid(6)}/rebuild`, body: { resetDocker: false } },
	]);
	const result = screen.getByTestId("bulk-result").textContent;
	expect(result).toContain("Rebuild requested for Alice Example.");
	expect(result).toContain("Skipped Bob Student");
	expect(result).not.toContain("Could not");
});

test("Rebuild all on older images appears only under the Older filter", async () => {
	stubUsers();
	await openTable();
	expect(screen.queryByTestId("rebuild-older")).toBeNull();
	fireEvent.change(screen.getByTestId("admin-filter-image"), {
		target: { value: "older" },
	});
	const button = screen.getByTestId("rebuild-older") as HTMLButtonElement;
	await waitFor(() => expect(button.disabled).toBe(false));
	fireEvent.click(button);
	const dialog = await screen.findByRole("alertdialog", {
		name: "Rebuild 1 workspace?",
	});
	expect(within(dialog).getByTestId("bulk-dialog-names").textContent).toBe(
		"Bob Student.",
	);
});

test("Also reset Docker starts unticked on every opening and a tick is sent", async () => {
	const posts: { url: string; body: unknown }[] = [];
	stubFetch((url, init) => {
		if (url === "/auth/me") return json(200, ADMIN_ME);
		if (isUsersList(url)) return usersBody(url, ROWS, false);
		if (init?.method === "POST") {
			posts.push({ url, body: JSON.parse(String(init.body)) });
			return json(202, { ok: true });
		}
		throw new Error(`unexpected request: ${url}`);
	});
	await openTable();
	fireEvent.change(screen.getByTestId("admin-filter-image"), {
		target: { value: "older" },
	});
	fireEvent.click(await screen.findByRole("checkbox", { name: "Select Bob Student" }));
	fireEvent.click(screen.getByTestId("bulk-rebuild"));
	let dialog = await screen.findByRole("alertdialog", { name: "Rebuild 1 workspace?" });
	fireEvent.click(within(dialog).getByRole("checkbox", { name: "Also reset Docker" }));
	fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
	await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

	await waitFor(() =>
		expect((screen.getByTestId("rebuild-older") as HTMLButtonElement).disabled).toBe(
			false,
		),
	);
	fireEvent.click(screen.getByTestId("rebuild-older"));
	dialog = await screen.findByRole("alertdialog", { name: "Rebuild 1 workspace?" });
	const reset = within(dialog).getByRole("checkbox", {
		name: "Also reset Docker",
	}) as HTMLInputElement;
	expect(reset.checked).toBe(false);
	// The checkbox sits after the description, not inside it (a11y finding A6).
	const describedBy = dialog.getAttribute("aria-describedby") ?? "";
	expect(document.getElementById(describedBy)?.contains(reset)).toBe(false);

	fireEvent.click(reset);
	fireEvent.click(within(dialog).getByRole("button", { name: "Rebuild" }));
	await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
	expect(posts).toEqual([
		{ url: `/admin/workspaces/${uuid(6)}/rebuild`, body: { resetDocker: true } },
	]);
});

test("the Account cell's second line carries the full contact as a title", async () => {
	stubUsers();
	await openTable();
	const contact = screen.getByTestId(`account-contact-${ROWS[0]?.id}`);
	expect(contact.getAttribute("title")).toBe(contact.textContent);
	expect(contact.className).toContain("truncate");
});

test("each column with a rule behind it, the Image filter and Show archived have one help button", async () => {
	stubUsers();
	await openTable();
	for (const label of [
		"Account tags",
		"Role",
		"Old image",
		"Activity",
		"Image filter",
		"Show archived",
	]) {
		expect(screen.getAllByRole("button", { name: `About ${label}` })).toHaveLength(1);
	}
	// Help sits beside the header text, so the header still reads as its name.
	const table = screen.getByTestId("admin-accounts");
	expect(within(table).getAllByRole("columnheader")[1]?.textContent).toBe("Account");
	expect(screen.getByTestId("intro-admin-users").textContent).toContain(
		"Everyone who has signed in, with their workspace.",
	);
});

test("the query string carries the filters, the sort and the page", () => {
	expect(usersQueryString(NO_FILTERS, DEFAULT_ACCOUNT_SORT)).toBe(
		"sort=account&dir=ascending",
	);
	expect(
		usersQueryString(
			{
				text: " ada ",
				state: "none",
				image: "older",
				role: "student",
				showArchived: true,
			},
			{ column: "activity", direction: "descending" },
			{ offset: 50, limit: 50 },
		),
	).toBe(
		"q=ada&role=student&state=none&image=older&archived=1&sort=activity&dir=descending&limit=50&offset=50",
	);
});

function manyId(n: number): string {
	return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

/** 120 students, answered 50 at a time by the stand-in server. */
function stubManyUsers() {
	const many = Array.from({ length: 120 }, (_, n) =>
		listed(n + 1, `Student ${String(n + 1).padStart(3, "0")}`, {
			id: manyId(n + 1),
		}),
	);
	const urls: string[] = [];
	stubFetch((url) => {
		if (url === "/auth/me") return json(200, ADMIN_ME);
		if (isUsersList(url)) {
			urls.push(url);
			return usersBody(url, many);
		}
		if (url === "/admin/settings") {
			return json(200, { shutdownGraceSeconds: 600, logLevel: null, updatedAt: null });
		}
		throw new Error(`unexpected request: ${url}`);
	});
	return urls;
}

test("the table asks for 50 accounts and pages with Previous and Next", async () => {
	const urls = stubManyUsers();
	renderApp("/admin");
	await screen.findByTestId(`account-row-${manyId(1)}`);
	expect(urls).toContain("/admin/users?sort=account&dir=ascending&limit=50&offset=0");
	expect(screen.getAllByRole("row")).toHaveLength(51);
	expect(screen.getByTestId("admin-account-count").textContent).toBe("120 accounts");
	expect(screen.getByTestId("admin-page-label").textContent).toBe("Page 1 of 3");
	expect(screen.getByTestId("admin-page-previous").getAttribute("aria-disabled")).toBe(
		"true",
	);
	fireEvent.click(screen.getByTestId("admin-page-previous"));
	expect(screen.getByTestId("admin-page-label").textContent).toBe("Page 1 of 3");

	fireEvent.click(screen.getByRole("checkbox", { name: "Select Student 001" }));
	fireEvent.click(screen.getByTestId("admin-page-next"));
	await screen.findByTestId(`account-row-${manyId(51)}`);
	expect(urls).toContain("/admin/users?sort=account&dir=ascending&limit=50&offset=50");
	expect(screen.queryByTestId(`account-row-${manyId(1)}`)).toBeNull();
	expect(screen.getByTestId("admin-page-announce").textContent).toBe(
		"Page 2 of 3, accounts 51 to 100 of 120",
	);
	// A selection belongs to its page.
	expect(screen.queryByTestId("bulk-actions")).toBeNull();

	fireEvent.click(screen.getByTestId("admin-page-next"));
	await screen.findByTestId(`account-row-${manyId(101)}`);
	expect(screen.getAllByRole("row")).toHaveLength(21);
	expect(screen.getByTestId("admin-page-announce").textContent).toBe(
		"Page 3 of 3, accounts 101 to 120 of 120",
	);
	expect(screen.getByTestId("admin-page-next").getAttribute("aria-disabled")).toBe(
		"true",
	);
});

test("a filter or a sort sends the server a new query and returns to page one", async () => {
	const urls = stubManyUsers();
	renderApp("/admin");
	await screen.findByTestId(`account-row-${manyId(1)}`);
	fireEvent.click(screen.getByTestId("admin-page-next"));
	await screen.findByTestId(`account-row-${manyId(51)}`);

	fireEvent.change(screen.getByLabelText("Search"), {
		target: { value: "student 01" },
	});
	await waitFor(() =>
		expect(urls).toContain(
			"/admin/users?q=student+01&sort=account&dir=ascending&limit=50&offset=0",
		),
	);
	await waitFor(() =>
		expect(screen.getByTestId("admin-account-count").textContent).toBe("10 accounts"),
	);
	// Ten matches fit on one page, so no pager.
	expect(screen.queryByTestId("admin-page-next")).toBeNull();

	fireEvent.click(
		within(screen.getByTestId("admin-accounts")).getByRole("button", {
			name: "Activity",
		}),
	);
	await waitFor(() =>
		expect(urls.some((url) => url.includes("sort=activity&dir=descending"))).toBe(true),
	);
});
