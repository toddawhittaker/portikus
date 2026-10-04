import type { AdminBackups, BackupKeyStatus } from "@portikus/contracts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { json, renderApp, stubFetch, USER } from "../../test-utils.js";

/**
 * The Backups tab's backup key on a server that backs itself up (ADR 0044):
 * the reminder, the confirmed download, and the upload with its explicit
 * replace step.
 */

afterEach(() => vi.unstubAllGlobals());

const RECIPIENT = `age1${"q".repeat(58)}`;
const OTHER = `age1${"p".repeat(58)}`;
const KEY_TEXT = `# public key: ${OTHER}\nAGE-SECRET-KEY-1${"Q".repeat(58)}\n`;

function status(overrides: Partial<BackupKeyStatus> = {}): BackupKeyStatus {
	return {
		installed: true,
		recipient: RECIPIENT,
		downloaded: false,
		downloadedAt: null,
		...overrides,
	};
}

const HOST: AdminBackups = {
	host: {
		vm: "local",
		reportedAt: new Date().toISOString(),
		nextRunAt: null,
		lastRun: null,
		lastFailure: null,
		running: null,
		keyInstalled: true,
		sets: [],
		dumps: [],
	},
	hostReportedAt: new Date().toISOString(),
	hostStale: false,
	vm: null,
	vmListedAt: null,
	requests: [],
	workspaces: [],
};

interface Call {
	method: string;
	url: string;
	body: unknown;
}

/** Serves the tab, the key status and the key writes; records the key calls. */
function stubSite(
	key: () => Response,
	writes: (call: Call) => Response,
	backups: AdminBackups = HOST,
) {
	const calls: Call[] = [];
	stubFetch((url, init) => {
		const method = init?.method ?? "GET";
		if (url === "/auth/me") return json(200, { ...USER, role: "administrator" });
		if (url === "/admin/backups") return json(200, backups);
		if (url === "/admin/backups/key" && method === "GET") return key();
		if (url.startsWith("/admin/backups/key")) {
			const call = {
				method,
				url,
				body: init?.body ? JSON.parse(String(init.body)) : null,
			};
			calls.push(call);
			return writes(call);
		}
		return json(200, {});
	});
	return calls;
}

let clicked: HTMLAnchorElement[];
beforeEach(() => {
	clicked = [];
	vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
		this: HTMLAnchorElement,
	) {
		clicked.push(this);
	});
	URL.createObjectURL = vi.fn(() => "blob:key");
	URL.revokeObjectURL = vi.fn();
});

function chooseFile(dialog: HTMLElement, text: string, size = text.length) {
	const file = new File([text], "portikus-backup-key.txt", { type: "text/plain" });
	Object.defineProperty(file, "size", { value: size });
	fireEvent.change(within(dialog).getByTestId("backup-key-file"), {
		target: { files: [file] },
	});
}

test("a site a separate host backs up shows no key section", async () => {
	stubSite(
		() => json(404, { code: "NOT_FOUND", message: "Not found." }),
		() => json(500, {}),
	);
	renderApp("/admin/backups");
	expect(await screen.findByTestId("backups-status")).toBeTruthy();
	expect(screen.queryByTestId("backups-key-group")).toBeNull();
	expect(screen.getByTestId("backups-key").textContent).toBe("Installed on the host");
});

test("a key not yet downloaded shows the reminder and the public half", async () => {
	stubSite(
		() => json(200, status()),
		() => json(500, {}),
	);
	renderApp("/admin/backups");
	const group = await screen.findByTestId("backups-key-group");
	expect(within(group).getByTestId("backup-key-reminder").textContent).toContain(
		"Backup key not yet downloaded.",
	);
	expect(within(group).getByTestId("backup-key-recipient").textContent).toBe(RECIPIENT);
	expect(within(group).getByTestId("backup-key-downloaded").textContent).toBe(
		"Not yet",
	);
	expect(screen.getByTestId("backups-key").textContent).toBe(
		"Installed on this server",
	);
});

test("a downloaded key shows no reminder", async () => {
	stubSite(
		() => json(200, status({ downloaded: true, downloadedAt: "2026-09-28T10:00:00Z" })),
		() => json(500, {}),
	);
	renderApp("/admin/backups");
	const group = await screen.findByTestId("backups-key-group");
	expect(within(group).queryByTestId("backup-key-reminder")).toBeNull();
	expect(within(group).getByTestId("backup-key-downloaded").textContent).not.toBe(
		"Not yet",
	);
});

test("the key section shows before the server's first backup report", async () => {
	stubSite(
		() => json(200, status()),
		() => json(500, {}),
		{ ...HOST, host: null, hostReportedAt: null, hostStale: true },
	);
	renderApp("/admin/backups");
	expect((await screen.findByTestId("backups-not-connected")).textContent).toContain(
		"has not reported yet",
	);
	expect(await screen.findByTestId("backup-key-reminder")).toBeTruthy();
});

test("download asks first, says what the key unlocks, and saves the file", async () => {
	let downloaded = false;
	const calls = stubSite(
		() =>
			json(
				200,
				status(
					downloaded
						? { downloaded: true, downloadedAt: new Date().toISOString() }
						: {},
				),
			),
		() => {
			downloaded = true;
			return new Response(KEY_TEXT, {
				status: 200,
				headers: { "content-type": "text/plain", "cache-control": "no-store" },
			});
		},
	);
	renderApp("/admin/backups");
	fireEvent.click(await screen.findByTestId("backup-key-download"));
	const dialog = await screen.findByTestId("backup-key-download-dialog");
	expect(dialog.textContent).toContain("unlocks every backup of this server");
	expect(dialog.textContent).toContain("Store it off this server");
	expect(calls).toEqual([]);

	fireEvent.click(within(dialog).getByTestId("dialog-confirm"));
	await waitFor(() => expect(clicked).toHaveLength(1));
	expect(calls).toEqual([
		{ method: "POST", url: "/admin/backups/key/download", body: null },
	]);
	expect(clicked[0]?.download).toBe("portikus-backup-key.txt");
	expect(clicked[0]?.href).toBe("blob:key");
	expect(await screen.findByText("Backup key downloaded")).toBeTruthy();
	await waitFor(() => expect(screen.queryByTestId("backup-key-reminder")).toBeNull());
});

test("cancelling the download sends nothing", async () => {
	const calls = stubSite(
		() => json(200, status()),
		() => json(500, {}),
	);
	renderApp("/admin/backups");
	fireEvent.click(await screen.findByTestId("backup-key-download"));
	const dialog = await screen.findByTestId("backup-key-download-dialog");
	fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
	await waitFor(() =>
		expect(screen.queryByTestId("backup-key-download-dialog")).toBeNull(),
	);
	expect(calls).toEqual([]);
	expect(clicked).toEqual([]);
});

test("a failed download says so and saves nothing", async () => {
	stubSite(
		() => json(200, status()),
		() =>
			json(503, {
				code: "BACKUP_KEY_UNAVAILABLE",
				message: "The server's backup key helper did not answer.",
			}),
	);
	renderApp("/admin/backups");
	fireEvent.click(await screen.findByTestId("backup-key-download"));
	const dialog = await screen.findByTestId("backup-key-download-dialog");
	fireEvent.click(within(dialog).getByTestId("dialog-confirm"));
	expect(await screen.findByText("Could not download the backup key")).toBeTruthy();
	expect(clicked).toEqual([]);
});

test("an upload onto a different key needs the replace step", async () => {
	const calls = stubSite(
		() => json(200, status()),
		(call) =>
			(call.body as { replace: boolean }).replace
				? json(200, {
						outcome: "installed",
						replacedRecipient: RECIPIENT,
						key: status({
							recipient: OTHER,
							downloaded: true,
							downloadedAt: new Date().toISOString(),
						}),
					})
				: json(409, {
						code: "BACKUP_KEY_EXISTS",
						message: "This server already has a different backup key.",
					}),
	);
	renderApp("/admin/backups");
	fireEvent.click(await screen.findByTestId("backup-key-upload"));
	const dialog = await screen.findByTestId("backup-key-upload-dialog");
	const confirm = within(dialog).getByTestId("dialog-confirm");
	expect(confirm.getAttribute("aria-disabled")).toBe("true");
	fireEvent.click(confirm);
	expect(calls).toEqual([]);

	chooseFile(dialog, KEY_TEXT);
	await waitFor(() => expect(confirm.getAttribute("aria-disabled")).toBeNull());
	fireEvent.click(confirm);

	const replace = await screen.findByTestId("backup-key-replace-dialog");
	expect(replace.textContent).toContain(
		"The current key is set aside on the server, readable only by root",
	);
	expect(calls).toEqual([
		{
			method: "POST",
			url: "/admin/backups/key",
			body: { key: KEY_TEXT, replace: false },
		},
	]);
	fireEvent.click(within(replace).getByTestId("dialog-confirm"));
	expect(await screen.findByText("Backup key replaced")).toBeTruthy();
	expect(calls[1]).toEqual({
		method: "POST",
		url: "/admin/backups/key",
		body: { key: KEY_TEXT, replace: true },
	});
	await waitFor(() =>
		expect(screen.getByTestId("backup-key-recipient").textContent).toBe(OTHER),
	);
	expect(screen.queryByTestId("backup-key-reminder")).toBeNull();
});

test("a failure on the replace step shows on the replace step", async () => {
	stubSite(
		() => json(200, status()),
		(call) =>
			(call.body as { replace: boolean }).replace
				? json(500, { code: "INTERNAL", message: "The key could not be saved." })
				: json(409, {
						code: "BACKUP_KEY_EXISTS",
						message: "This server already has a different backup key.",
					}),
	);
	renderApp("/admin/backups");
	fireEvent.click(await screen.findByTestId("backup-key-upload"));
	const dialog = await screen.findByTestId("backup-key-upload-dialog");
	chooseFile(dialog, KEY_TEXT);
	const confirm = within(dialog).getByTestId("dialog-confirm");
	await waitFor(() => expect(confirm.getAttribute("aria-disabled")).toBeNull());
	fireEvent.click(confirm);
	const replace = await screen.findByTestId("backup-key-replace-dialog");
	fireEvent.click(within(replace).getByTestId("dialog-confirm"));
	expect((await within(replace).findByRole("alert")).textContent).toBe(
		"The key could not be saved.",
	);
	expect(screen.queryByTestId("backup-key-upload-dialog")).toBeNull();
});

test("a file the server refuses shows why in the dialog", async () => {
	stubSite(
		() => json(200, status()),
		() =>
			json(400, {
				code: "BACKUP_KEY_INVALID",
				message: "That file is not a backup key.",
			}),
	);
	renderApp("/admin/backups");
	fireEvent.click(await screen.findByTestId("backup-key-upload"));
	const dialog = await screen.findByTestId("backup-key-upload-dialog");
	chooseFile(dialog, "hello\n");
	const confirm = within(dialog).getByTestId("dialog-confirm");
	await waitFor(() => expect(confirm.getAttribute("aria-disabled")).toBeNull());
	fireEvent.click(confirm);
	expect((await within(dialog).findByRole("alert")).textContent).toBe(
		"That file is not a backup key.",
	);
	expect(screen.queryByTestId("backup-key-replace-dialog")).toBeNull();
});

test("a file larger than any key is refused before it is sent", async () => {
	const calls = stubSite(
		() => json(200, status({ installed: false, recipient: null })),
		() => json(500, {}),
	);
	renderApp("/admin/backups");
	const group = await screen.findByTestId("backups-key-group");
	// No key: nothing to download, and nothing to be reminded of.
	expect(within(group).queryByTestId("backup-key-download")).toBeNull();
	expect(within(group).queryByTestId("backup-key-reminder")).toBeNull();
	fireEvent.click(within(group).getByTestId("backup-key-upload"));
	const dialog = await screen.findByTestId("backup-key-upload-dialog");
	chooseFile(dialog, "x", 5000);
	expect((await within(dialog).findByRole("alert")).textContent).toContain(
		"not a backup key",
	);
	// The error belongs to the labelled file field.
	const input = within(dialog).getByLabelText("Backup key file");
	expect(input.getAttribute("type")).toBe("file");
	expect(input.getAttribute("aria-invalid")).toBe("true");
	expect(
		document.getElementById(input.getAttribute("aria-describedby") ?? "")?.textContent,
	).toContain("not a backup key");
	fireEvent.click(within(dialog).getByTestId("dialog-confirm"));
	expect(calls).toEqual([]);
});

test("a second too-large file mounts a fresh alert, so the same message is read again", async () => {
	stubSite(
		() => json(200, status({ installed: false, recipient: null })),
		() => json(500, {}),
	);
	renderApp("/admin/backups");
	const group = await screen.findByTestId("backups-key-group");
	fireEvent.click(within(group).getByTestId("backup-key-upload"));
	const dialog = await screen.findByTestId("backup-key-upload-dialog");
	chooseFile(dialog, "x", 5000);
	const first = await within(dialog).findByRole("alert");
	chooseFile(dialog, "y", 6000);
	await waitFor(() => expect(within(dialog).getByRole("alert")).not.toBe(first));
	expect(first.isConnected).toBe(false);
	expect(within(dialog).getByRole("alert").textContent).toBe(first.textContent);
});

test("the not-downloaded reminder is a warning notice, not a plain card", async () => {
	stubSite(
		() => json(200, status()),
		() => json(500, {}),
	);
	renderApp("/admin/backups");
	const reminder = await screen.findByTestId("backup-key-reminder");
	expect(reminder.classList.contains("bg-status-warning-soft")).toBe(true);
	expect(reminder.classList.contains("pk-card")).toBe(false);
});
