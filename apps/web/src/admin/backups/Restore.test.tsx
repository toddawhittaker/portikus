import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { json, renderApp, renderWithQuery } from "../../test-utils.js";
import { RestoreFromBackupDialog } from "./BackupDialogs.js";
import {
	ALICE_INSTANCE,
	ALICE_WS,
	BOB_WS,
	backups,
	COPY_ID,
	FAILED,
	NEW,
	stubBackups,
	view,
} from "./testBackups.js";

/** Restoring a set into a side copy, and replacing a home with it. */

afterEach(() => vi.unstubAllGlobals());

test("restore picks a running workspace and names the folder", async () => {
	const writes = stubBackups(backups());
	renderApp("/admin/backups");
	const row = await screen.findByTestId(`backup-set-${NEW}`);
	fireEvent.click(within(row).getByTestId("backup-set-restore"));
	const dialog = await screen.findByTestId("backup-restore-dialog");
	expect(within(dialog).getByTestId("backup-restore-folder").textContent).toBe(
		"~/restored-2026-09-24-0230",
	);
	const confirm = within(dialog).getByTestId("backup-restore-confirm");
	expect(confirm.getAttribute("aria-disabled")).toBe("true");
	expect(confirm.getAttribute("aria-describedby")).toBe("backup-restore-choose");
	expect(within(dialog).getByText("Choose a workspace to restore.")).toBeTruthy();
	// Mounted empty before any choice, so a later warning is announced.
	expect(within(dialog).getByRole("status").textContent).toBe("");

	fireEvent.click(within(dialog).getByLabelText("Workspace"));
	fireEvent.click(
		await screen.findByRole("option", { name: "Bob Jones (bob), stopped" }),
	);
	await waitFor(() =>
		expect(within(dialog).getByRole("status").textContent).toContain(
			"Start this workspace first.",
		),
	);
	fireEvent.click(confirm);
	expect(writes).toEqual([]);

	fireEvent.click(within(dialog).getByLabelText("Workspace"));
	fireEvent.click(await screen.findByRole("option", { name: "Alice Smith (alice)" }));
	await waitFor(() => expect(confirm.getAttribute("aria-disabled")).toBeNull());
	fireEvent.click(confirm);
	await waitFor(() =>
		expect(writes).toEqual([
			{
				method: "POST",
				url: "/admin/backups/restores",
				body: { stamp: NEW, workspaceId: ALICE_WS },
			},
		]),
	);
});

test("a refused restore keeps the dialog open with the reason", async () => {
	stubBackups(backups(), () =>
		json(409, { code: "WORKSPACE_NOT_RUNNING", message: "Start the workspace first" }),
	);
	renderApp("/admin/backups");
	const row = await screen.findByTestId(`backup-set-${NEW}`);
	fireEvent.click(within(row).getByTestId("backup-set-restore"));
	const dialog = await screen.findByTestId("backup-restore-dialog");
	fireEvent.click(within(dialog).getByLabelText("Workspace"));
	fireEvent.click(await screen.findByRole("option", { name: "Alice Smith (alice)" }));
	fireEvent.click(within(dialog).getByTestId("backup-restore-confirm"));
	expect((await within(dialog).findByRole("alert")).textContent).toBe(
		"Start the workspace first",
	);
});

test("without the restore key, Restore is off and says why", async () => {
	const data = backups();
	stubBackups({ ...data, host: data.host && { ...data.host, keyInstalled: false } });
	renderApp("/admin/backups");
	const row = await screen.findByTestId(`backup-set-${NEW}`);
	const restore = within(row).getByTestId("backup-set-restore");
	expect(restore.getAttribute("aria-disabled")).toBe("true");
	expect(restore.getAttribute("aria-describedby")).toBe("backups-key-note");
	fireEvent.click(restore);
	expect(screen.queryByTestId("backup-restore-dialog")).toBeNull();
});

test("replace home needs the workspace label typed", async () => {
	const writes = stubBackups(backups());
	renderApp("/admin/backups");
	const copy = await screen.findByTestId("backup-copy");
	expect(copy.textContent).toContain("Copied");
	fireEvent.click(within(copy).getByTestId("backup-copy-replace"));
	const dialog = await screen.findByTestId("backup-replace-dialog");
	expect(dialog.textContent).toContain(
		"Each active project gets a recovery point first.",
	);
	const confirm = within(dialog).getByTestId("dialog-confirm") as HTMLButtonElement;
	expect(confirm.disabled).toBe(true);
	fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "alice" } });
	expect(confirm.disabled).toBe(false);
	fireEvent.click(confirm);
	await waitFor(() =>
		expect(writes).toEqual([
			{
				method: "POST",
				url: `/admin/backups/restores/${COPY_ID}/replace-home`,
				body: null,
			},
		]),
	);
});

test("a failed copy shows the host's reason and no Replace", async () => {
	const data = backups();
	stubBackups({
		...data,
		requests: [
			view({
				kind: "restore_copy",
				args: { stamp: NEW, instance: ALICE_INSTANCE, dir: "restored-2026-09-24-0230" },
				workspaceId: ALICE_WS,
				state: "failed",
				error: "~/restored-2026-09-24-0230 already exists.",
			}),
		],
	});
	renderApp("/admin/backups");
	const copy = await screen.findByTestId("backup-copy");
	expect(copy.textContent).toContain("already exists");
	expect(within(copy).queryByTestId("backup-copy-replace")).toBeNull();
});

describe("restore from a workspace's panel (preset workspace)", () => {
	test("lists only the sets holding the workspace, newest first, and restores the chosen one", async () => {
		const writes = stubBackups(backups());
		renderWithQuery(
			<RestoreFromBackupDialog workspaceId={BOB_WS} onClose={() => {}} />,
		);
		const dialog = await screen.findByTestId("backup-restore-dialog");
		expect(within(dialog).getByRole("heading").textContent).toBe("Restore from backup");
		expect(
			(await within(dialog).findByTestId("backup-restore-workspace-name")).textContent,
		).toBe("Bob Jones (bob)");
		// The newest set holding Bob is chosen for you; FAILED does not hold him.
		await waitFor(() =>
			expect(within(dialog).getByTestId("backup-restore-folder").textContent).toBe(
				"~/restored-2026-09-24-0230",
			),
		);
		fireEvent.click(within(dialog).getByLabelText("Backup set"));
		const options = await screen.findAllByRole("option");
		expect(options.map((o) => o.textContent)).toEqual([
			"Sep 24, 2026, 02:30 UTC",
			"Sep 20, 2026, 02:30 UTC",
		]);
		fireEvent.click(options[1] as HTMLElement);
		await waitFor(() =>
			expect(within(dialog).getByTestId("backup-restore-folder").textContent).toBe(
				"~/restored-2026-09-20-0230",
			),
		);
		// Bob's workspace is stopped, so the copy cannot be made yet.
		const confirm = within(dialog).getByTestId("backup-restore-confirm");
		expect(confirm.getAttribute("aria-disabled")).toBe("true");
		expect(confirm.getAttribute("aria-describedby")).toBe("backup-restore-stopped");
		fireEvent.click(confirm);
		expect(writes).toEqual([]);
	});

	test("a running workspace is restored from the chosen set", async () => {
		const writes = stubBackups(backups());
		const onClose = vi.fn();
		renderWithQuery(
			<RestoreFromBackupDialog workspaceId={ALICE_WS} onClose={onClose} />,
		);
		const dialog = await screen.findByTestId("backup-restore-dialog");
		const confirm = within(dialog).getByTestId("backup-restore-confirm");
		await waitFor(() => expect(confirm.getAttribute("aria-disabled")).toBeNull());
		fireEvent.click(confirm);
		await waitFor(() =>
			expect(writes).toEqual([
				{
					method: "POST",
					url: "/admin/backups/restores",
					body: { stamp: FAILED, workspaceId: ALICE_WS },
				},
			]),
		);
		await waitFor(() => expect(onClose).toHaveBeenCalled());
	});

	test("a set that is not verified is not offered", async () => {
		const data = backups();
		stubBackups({
			...data,
			host: data.host && {
				...data.host,
				sets: data.host.sets.map((each) =>
					each.stamp === NEW ? { ...each, verified: false } : each,
				),
			},
		});
		renderWithQuery(
			<RestoreFromBackupDialog workspaceId={BOB_WS} onClose={() => {}} />,
		);
		const dialog = await screen.findByTestId("backup-restore-dialog");
		await waitFor(() =>
			expect(within(dialog).getByTestId("backup-restore-folder").textContent).toBe(
				"~/restored-2026-09-20-0230",
			),
		);
		fireEvent.click(within(dialog).getByLabelText("Backup set"));
		const options = await screen.findAllByRole("option");
		expect(options.map((o) => o.textContent)).toEqual(["Sep 20, 2026, 02:30 UTC"]);
	});

	test("a workspace no set holds says so and cannot restore", async () => {
		stubBackups(backups());
		renderWithQuery(
			<RestoreFromBackupDialog
				workspaceId="99999999-bbbb-4ccc-8ddd-eeeeeeeeeeee"
				onClose={() => {}}
			/>,
		);
		const dialog = await screen.findByTestId("backup-restore-dialog");
		expect((await within(dialog).findByTestId("backup-restore-none")).textContent).toBe(
			"No backup set holds this workspace yet.",
		);
		const confirm = within(dialog).getByTestId("backup-restore-confirm");
		expect(confirm.getAttribute("aria-disabled")).toBe("true");
		expect(confirm.getAttribute("aria-describedby")).toBe("backup-restore-none");
	});

	test("a workspace only unverified sets hold says they cannot be restored", async () => {
		const data = backups();
		stubBackups({
			...data,
			host: data.host && {
				...data.host,
				sets: data.host.sets.map((each) => ({ ...each, verified: false })),
			},
		});
		renderWithQuery(
			<RestoreFromBackupDialog workspaceId={ALICE_WS} onClose={() => {}} />,
		);
		const dialog = await screen.findByTestId("backup-restore-dialog");
		expect((await within(dialog).findByTestId("backup-restore-none")).textContent).toBe(
			"Only unverified backup sets hold this workspace, and they cannot be restored.",
		);
		expect(
			within(dialog)
				.getByTestId("backup-restore-confirm")
				.getAttribute("aria-disabled"),
		).toBe("true");
	});

	test("a site without a backup host says backups are not connected", async () => {
		stubBackups(backups({ host: null, workspaces: [] }));
		renderWithQuery(
			<RestoreFromBackupDialog workspaceId={ALICE_WS} onClose={() => {}} />,
		);
		const dialog = await screen.findByTestId("backup-restore-dialog");
		// Only that one line: no "no set holds this workspace", no folder, no running rule.
		expect((await within(dialog).findByTestId("backup-restore-none")).textContent).toBe(
			"Backups are not connected on this site.",
		);
		expect(
			within(dialog).queryByText("No backup set holds this workspace yet."),
		).toBeNull();
		expect(within(dialog).queryByTestId("backup-restore-folder")).toBeNull();
		expect(within(dialog).queryByRole("combobox")).toBeNull();
		const confirm = within(dialog).getByTestId("backup-restore-confirm");
		expect(confirm.getAttribute("aria-disabled")).toBe("true");
		expect(confirm.getAttribute("aria-describedby")).toBe("backup-restore-none");
	});

	test("renders and fetches nothing while no workspace is given", () => {
		const fetch = stubBackups(backups());
		renderWithQuery(<RestoreFromBackupDialog workspaceId={null} onClose={() => {}} />);
		expect(screen.queryByTestId("backup-restore-dialog")).toBeNull();
		expect(fetch).toEqual([]);
	});
});
