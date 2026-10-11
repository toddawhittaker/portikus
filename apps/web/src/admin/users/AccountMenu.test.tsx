import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { accountMenuGroups } from "./AccountMenu.js";
import { account, NONE, openTable, stubUsers, summary, uuid } from "./testRows.js";

afterEach(() => vi.unstubAllGlobals());

test("a running workspace offers Stop and Restart, then Rebuild, then Archive and Disable", () => {
	const user = account("Ann", summary({ state: "running" }));
	expect(accountMenuGroups(user, "me")).toEqual({
		lifecycle: ["stop", "restart"],
		confirm: [["rebuild"], ["archive", "disable"]],
	});
});

test("an archived workspace offers no lifecycle and no rebuild, only Unarchive", () => {
	const user = account(
		"Ann",
		summary({ state: "stopped", archivedAt: "2026-09-01T00:00:00.000Z" }),
		{ markers: { ...NONE, archived: true }, disabledAt: "2026-09-02T00:00:00.000Z" },
	);
	expect(accountMenuGroups(user, "me")).toEqual({
		lifecycle: [],
		confirm: [["unarchive", "enable"]],
	});
});

test("your own account without a workspace has nothing to offer, so no menu button", async () => {
	const self = account("Me", null, { id: "me" });
	expect(accountMenuGroups(self, "me")).toEqual({ lifecycle: [], confirm: [] });
	stubUsers();
	await openTable();
	// Carol Admin is the signed-in administrator and has no workspace.
	expect(screen.queryByTestId(`account-menu-${uuid(9)}`)).toBeNull();
	expect(screen.getByTestId(`account-menu-${uuid(3)}`)).toBeDefined();
});

function openMenu(userId: string) {
	fireEvent.keyDown(screen.getByTestId(`account-menu-${userId}`), { key: "Enter" });
}

test("the row menu is named for the account and lists that row's actions", async () => {
	stubUsers();
	await openTable();
	const button = screen.getByRole("button", { name: "Actions for Alice Example" });
	expect(button.getAttribute("aria-haspopup")).toBe("menu");
	openMenu(uuid(1));
	const menu = await screen.findByRole("menu", { name: "Actions for Alice Example" });
	expect(
		within(menu)
			.getAllByRole("menuitem")
			.map((item) => item.textContent),
	).toEqual([
		"Stop",
		"Restart",
		"Rebuild workspace…",
		"Archive workspace…",
		"Disable account…",
	]);
});

test("Stop from the menu posts the workspace's stop and says so", async () => {
	const writes = stubUsers();
	await openTable();
	openMenu(uuid(1));
	fireEvent.click(await screen.findByTestId("account-menu-stop"));
	await waitFor(() => expect(writes).toEqual([`/workspaces/${uuid(5)}/stop`]));
	expect(
		await screen.findByText("Asked to stop Alice Example's workspace"),
	).toBeDefined();
});

test("while a stop runs, the lifecycle items stay reachable but do nothing", async () => {
	stubUsers();
	const base = globalThis.fetch;
	let release: (response: Response) => void = () => {};
	const held = new Promise<Response>((resolve) => {
		release = resolve;
	});
	const posts: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
			if (init?.method !== "POST") return base(input, init);
			posts.push(String(input));
			return held;
		}),
	);
	await openTable();
	openMenu(uuid(1));
	fireEvent.click(await screen.findByTestId("account-menu-stop"));
	await waitFor(() => expect(posts).toHaveLength(1));

	openMenu(uuid(1));
	const stop = await screen.findByTestId("account-menu-stop");
	const restart = screen.getByTestId("account-menu-restart");
	expect(stop.textContent).toBe("Stopping…");
	expect(stop.getAttribute("aria-disabled")).toBe("true");
	expect(restart.getAttribute("aria-disabled")).toBe("true");
	// Radix's disabled would take them out of the arrow-key order.
	expect(restart.hasAttribute("data-disabled")).toBe(false);
	fireEvent.click(restart);
	expect(posts).toHaveLength(1);

	release(new Response(null, { status: 204 }));
	await waitFor(() => expect(stop.textContent).toBe("Stop"));
	expect(stop.hasAttribute("aria-disabled")).toBe(false);
});

test("Disable from the menu confirms one account, leaves ticks alone and returns focus to the row's button", async () => {
	const writes = stubUsers();
	await openTable();
	fireEvent.click(screen.getByRole("checkbox", { name: "Select Bob Student" }));
	const trigger = screen.getByTestId(`account-menu-${uuid(1)}`);
	trigger.focus();
	openMenu(uuid(1));
	fireEvent.click(await screen.findByTestId("account-menu-disable"));

	const dialog = await screen.findByRole("alertdialog", { name: "Disable 1 account?" });
	expect(within(dialog).getByTestId("bulk-dialog-names").textContent).toBe(
		"Alice Example.",
	);
	fireEvent.click(within(dialog).getByRole("button", { name: "Disable" }));

	await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
	expect(writes).toEqual([`/admin/users/${uuid(1)}/disable`]);
	expect(screen.getByTestId("bulk-result").textContent).toBe("Disabled Alice Example.");
	await waitFor(() => expect(document.activeElement).toBe(trigger));
	expect(
		(screen.getByRole("checkbox", { name: "Select Bob Student" }) as HTMLInputElement)
			.checked,
	).toBe(true);
});

test("Archive from the menu, with archived rows hidden, sends focus to the summary", async () => {
	stubUsers();
	await openTable();
	openMenu(uuid(1));
	fireEvent.click(await screen.findByTestId("account-menu-archive"));
	const dialog = await screen.findByRole("alertdialog");
	fireEvent.click(within(dialog).getByRole("button", { name: "Archive" }));
	const result = screen.getByTestId("bulk-result");
	await waitFor(() => expect(document.activeElement).toBe(result));
});

test("pressing a column header sorts the rows and says so in the caption", async () => {
	stubUsers();
	await openTable();
	const table = screen.getByTestId("admin-accounts");
	const order = () =>
		within(table)
			.getAllByRole("button", { name: /^Show details for/ })
			.map((button) => button.textContent);
	expect(order()).toEqual([
		"Alice Example",
		"Bob Student",
		"Carol Admin",
		"Gina Granted",
		"Sam Course",
	]);
	const account = within(table).getByRole("columnheader", { name: /^Account/ });
	expect(account.getAttribute("aria-sort")).toBe("ascending");

	fireEvent.click(within(table).getByRole("button", { name: "Account" }));
	expect(account.getAttribute("aria-sort")).toBe("descending");
	await waitFor(() => expect(order()[0]).toBe("Sam Course"));
	expect(table.querySelector("caption")?.textContent).toContain(
		"sorted by Account, descending",
	);
	expect(screen.getByTestId("admin-sort-announce").textContent).toBe(
		"Sorted by Account, descending",
	);

	// Activity starts with the most recent: Alice is connected now.
	fireEvent.click(within(table).getByRole("button", { name: "Activity" }));
	expect(account.hasAttribute("aria-sort")).toBe(false);
	expect(
		within(table)
			.getByRole("columnheader", { name: /^Activity/ })
			.getAttribute("aria-sort"),
	).toBe("descending");
	await waitFor(() => expect(order()[0]).toBe("Alice Example"));
});
