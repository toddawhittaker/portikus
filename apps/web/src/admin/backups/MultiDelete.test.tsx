import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { json, renderApp } from "../../test-utils.js";
import { backups, FAILED, NEW, OLD, stubBackups, view } from "./testBackups.js";

/** Ticking rows across the four lists and deleting them with one confirm (SPEC.md §20.1, §24.11). */

afterEach(() => vi.unstubAllGlobals());

function box(name: string) {
	return screen.getByRole("checkbox", { name }) as HTMLInputElement;
}

test("the newest complete set's box is unavailable and says why; select all skips it", async () => {
	stubBackups(backups());
	renderApp("/admin/backups");
	const newest = within(await screen.findByTestId(`backup-set-${NEW}`)).getByRole(
		"checkbox",
	);
	expect(newest.getAttribute("aria-disabled")).toBe("true");
	expect(newest.getAttribute("aria-describedby")).toBeTruthy();
	const description = document.getElementById(
		newest.getAttribute("aria-describedby") ?? "",
	);
	expect(description?.textContent).toBe("The newest complete set is always kept");
	// The click is cancelled, so nothing is selected.
	expect(fireEvent.click(newest)).toBe(false);
	expect(screen.getByTestId("backup-selected-count").textContent).toBe("");
	expect(screen.queryByTestId("backups-sets-title-delete-selected")).toBeNull();

	fireEvent.click(box("Select all backup sets"));
	const rowBox = (stamp: string) =>
		within(screen.getByTestId(`backup-set-${stamp}`)).getByRole(
			"checkbox",
		) as HTMLInputElement;
	expect(rowBox(FAILED).checked).toBe(true);
	expect(rowBox(OLD).checked).toBe(true);
	expect(box("Select all backup sets").checked).toBe(true);
	expect(screen.getByTestId("backup-selected-count").textContent).toBe("2 selected");
	expect(screen.getByTestId("backups-sets-title-delete-selected").textContent).toBe(
		"Delete 2 selected…",
	);

	fireEvent.click(rowBox(OLD));
	expect(box("Select all backup sets").indeterminate).toBe(true);
	expect(screen.getByTestId("backup-selected-count").textContent).toBe("1 selected");
});

test("ticking rows in two lists deletes them all with one confirm naming count and kinds", async () => {
	const writes = stubBackups(backups());
	renderApp("/admin/backups");
	await screen.findByTestId(`backup-set-${OLD}`);
	expect(screen.queryByTestId("backups-sets-title-delete-selected")).toBeNull();

	fireEvent.click(box("Select all backup sets"));
	fireEvent.click(box("Select portikus-pre-upgrade.dump"));
	const button = screen.getByTestId("backups-dumps-title-delete-selected");
	expect(button.textContent).toBe("Delete 3 selected…");
	// The sets list shows the same action, since it has ticked rows too.
	expect(screen.getByTestId("backups-sets-title-delete-selected")).toBeTruthy();
	expect(screen.queryByTestId("backups-kept-title-delete-selected")).toBeNull();

	fireEvent.click(button);
	const dialog = await screen.findByTestId("backup-delete-dialog");
	expect(within(dialog).getByRole("heading").textContent).toBe("Delete 3 items?");
	expect(dialog.textContent).toContain("2 backup sets and 1 database dump.");
	expect(dialog.textContent).not.toContain("portikus-pre-upgrade.dump");
	fireEvent.click(within(dialog).getByTestId("dialog-confirm"));

	await waitFor(() => expect(screen.queryByTestId("backup-delete-dialog")).toBeNull());
	// One request per item, in page order, each through its own route.
	expect(writes.map((w) => `${w.method} ${w.url}`)).toEqual([
		`DELETE /admin/backups/sets/${FAILED}`,
		`DELETE /admin/backups/sets/${OLD}`,
		"DELETE /admin/backups/dumps/portikus-pre-upgrade.dump",
	]);
	expect(
		await screen.findByText("Delete requested for 2 backup sets and 1 database dump"),
	).toBeTruthy();
	expect(
		screen
			.getAllByRole("checkbox")
			.some((input) => (input as HTMLInputElement).checked),
	).toBe(false);
	expect(screen.queryByTestId("backups-dumps-title-delete-selected")).toBeNull();
});

test("a partial failure keeps the confirm open on what was not deleted, still ticked", async () => {
	const writes = stubBackups(backups(), (url) =>
		url.includes(OLD)
			? json(409, {
					code: "BACKUP_RUNNING",
					message: "The host is busy with that set.",
				})
			: json(202, view({})),
	);
	renderApp("/admin/backups");
	await screen.findByTestId(`backup-set-${OLD}`);
	fireEvent.click(box("Select all backup sets"));
	fireEvent.click(screen.getByTestId("backups-sets-title-delete-selected"));
	const dialog = await screen.findByTestId("backup-delete-dialog");
	expect(within(dialog).getByRole("heading").textContent).toBe("Delete 2 backup sets?");
	fireEvent.click(within(dialog).getByTestId("dialog-confirm"));

	const failed = await within(dialog).findByText(/This was not deleted/);
	expect(failed.closest("[role=alert]")).toBeTruthy();
	const alert = within(dialog).getByTestId("backup-delete-failed");
	expect(alert.textContent).toContain("Delete requested for 1 backup set.");
	expect(alert.textContent).toMatch(
		/The backup set from .*: The host is busy with that set\./,
	);
	// The title now asks about what is left.
	expect(within(dialog).getByRole("heading").textContent).toMatch(
		/^Delete the backup set from /,
	);
	expect(writes).toHaveLength(2);

	fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
	await waitFor(() => expect(screen.queryByTestId("backup-delete-dialog")).toBeNull());
	const old = within(screen.getByTestId(`backup-set-${OLD}`)).getByRole(
		"checkbox",
	) as HTMLInputElement;
	const done = within(screen.getByTestId(`backup-set-${FAILED}`)).getByRole(
		"checkbox",
	) as HTMLInputElement;
	expect(old.checked).toBe(true);
	expect(done.checked).toBe(false);
	expect(screen.getByTestId("backups-sets-title-delete-selected").textContent).toBe(
		"Delete 1 selected…",
	);
});

test("a row's own Delete asks about that row alone, whatever is ticked", async () => {
	const writes = stubBackups(backups());
	renderApp("/admin/backups");
	await screen.findByTestId(`backup-set-${OLD}`);
	fireEvent.click(box("Select all backup sets"));
	fireEvent.click(screen.getByTestId("backup-dump-delete"));
	const dialog = await screen.findByTestId("backup-delete-dialog");
	expect(within(dialog).getByRole("heading").textContent).toBe(
		"Delete portikus-pre-upgrade.dump?",
	);
	fireEvent.click(within(dialog).getByTestId("dialog-confirm"));
	await waitFor(() => expect(screen.queryByTestId("backup-delete-dialog")).toBeNull());
	expect(writes.map((w) => w.url)).toEqual([
		"/admin/backups/dumps/portikus-pre-upgrade.dump",
	]);
	expect(screen.getByTestId("backups-sets-title-delete-selected").textContent).toBe(
		"Delete 2 selected…",
	);
});

test("a row whose delete is waiting cannot be ticked", async () => {
	stubBackups(
		backups({
			requests: [
				view({
					kind: "delete_dump",
					args: { file: "portikus-pre-upgrade.dump" },
					state: "pending",
				}),
			],
		}),
	);
	renderApp("/admin/backups");
	await screen.findByTestId("backup-dump");
	const dump = box("Select portikus-pre-upgrade.dump");
	expect(dump.getAttribute("aria-disabled")).toBe("true");
	const all = box("Select all pre-change database dumps");
	expect(all.getAttribute("aria-disabled")).toBe("true");
	fireEvent.click(all);
	expect(dump.checked).toBe(false);
});
