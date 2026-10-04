import type {
	AccountImportPreviewRow,
	AccountImportResultRow,
} from "@portikus/contracts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { json, renderApp, stubFetch, USER } from "../../test-utils.js";
import { passwordsCsv, SAMPLE_IMPORT_CSV } from "./importCsv.js";

/** Import from CSV in the Users view (SPEC.md section 5.1, "Add user"). */

afterEach(() => vi.unstubAllGlobals());

const ADMIN = {
	...USER,
	id: "33333333-3333-4333-8333-333333333333",
	displayName: "Carol Admin",
	role: "administrator" as const,
};

const CSV = "name,email,username,role,kind\nPat,pat@example.edu,pat,student,password\n";

const PREVIEW: AccountImportPreviewRow[] = [
	{
		line: 2,
		name: "Pat",
		email: "pat@example.edu",
		username: "pat",
		role: "student",
		kind: "password",
		status: "valid",
		reason: null,
	},
	{
		line: 3,
		name: "Al",
		email: "al@example.edu",
		username: "al",
		role: "administrator",
		kind: "password",
		status: "invalid",
		reason: "Administrators cannot be imported.",
	},
];

const RESULT: AccountImportResultRow[] = [
	{
		line: 2,
		name: "Pat",
		email: "pat@example.edu",
		username: "pat",
		kind: "password",
		outcome: "created",
		reason: null,
		password: "Secret123Secret123ab",
	},
	{
		line: 3,
		name: "Al",
		email: "al@example.edu",
		username: "al",
		kind: "password",
		outcome: "invalid",
		reason: "Administrators cannot be imported.",
	},
];

function stub() {
	const writes: { url: string; body: unknown }[] = [];
	stubFetch((url, init) => {
		if (url === "/auth/me") return json(200, ADMIN);
		if (url === "/admin/users") return json(200, { users: [], dexUsers: true });
		if (url === "/admin/invitations") return json(200, { invitations: [] });
		if (init?.method === "POST") {
			writes.push({ url, body: init.body ? JSON.parse(String(init.body)) : null });
			if (url === "/admin/accounts/import/preview") return json(200, { rows: PREVIEW });
			if (url === "/admin/accounts/import") return json(200, { rows: RESULT });
		}
		return json(404, { code: "NOT_FOUND", message: "Not found." });
	});
	return writes;
}

test("a file is previewed, confirmed with the same text, and the passwords offered", async () => {
	const writes = stub();
	renderApp("/admin");
	fireEvent.click(await screen.findByRole("button", { name: "Import from CSV…" }));
	const dialog = await screen.findByRole("dialog", { name: "Import from CSV" });
	const file = new File([CSV], "people.csv", { type: "text/csv" });
	fireEvent.change(within(dialog).getByLabelText("CSV file"), {
		target: { files: [file] },
	});
	const table = await within(dialog).findByRole("table", { name: "Rows in the file" });
	expect(within(table).getByText("Administrators cannot be imported.")).toBeTruthy();
	expect(within(dialog).getByTestId("import-summary").textContent).toBe(
		"1 row is ready to add. 1 row will be skipped.",
	);
	fireEvent.click(within(dialog).getByRole("button", { name: "Add 1 account" }));
	const done = await screen.findByRole("dialog", { name: "Import finished" });
	expect(within(done).getByTestId("import-result").textContent).toBe(
		"1 account added, 0 invitations sent, 1 row skipped.",
	);
	expect(within(done).getByTestId("import-password-warning").textContent).toContain(
		"will not be shown again",
	);
	expect(within(done).getByRole("button", { name: "Download passwords" })).toBeTruthy();
	// The password is never painted on the page, only offered as a file.
	expect(done.textContent).not.toContain("Secret123Secret123ab");
	expect(writes).toEqual([
		{ url: "/admin/accounts/import/preview", body: { csv: CSV } },
		{ url: "/admin/accounts/import", body: { csv: CSV } },
	]);
});

test("a file refused whole shows the reason on the picker", async () => {
	stubFetch((url) => {
		if (url === "/auth/me") return json(200, ADMIN);
		if (url === "/admin/users") return json(200, { users: [], dexUsers: false });
		if (url === "/admin/invitations") return json(200, { invitations: [] });
		return json(400, {
			code: "VALIDATION_FAILED",
			message: 'The header has no "kind" column.',
		});
	});
	renderApp("/admin");
	fireEvent.click(await screen.findByRole("button", { name: "Import from CSV…" }));
	const dialog = await screen.findByRole("dialog", { name: "Import from CSV" });
	fireEvent.change(within(dialog).getByLabelText("CSV file"), {
		target: { files: [new File(["name\n"], "bad.csv")] },
	});
	await waitFor(() =>
		expect(dialog.textContent).toContain('The header has no "kind" column.'),
	);
	expect(
		(within(dialog).getByRole("button", { name: "Add accounts" }) as HTMLButtonElement)
			.disabled,
	).toBe(true);
});

test("the passwords file quotes cells and defuses spreadsheet formulas", () => {
	const text = passwordsCsv([
		{ ...RESULT[0], name: "Lee, Ann" } as AccountImportResultRow,
		{ ...RESULT[0], name: "=HYPERLINK()", username: "x" } as AccountImportResultRow,
		RESULT[1] as AccountImportResultRow,
	]);
	expect(text).toBe(
		'name,username,one-time password\r\n"Lee, Ann",pat,Secret123Secret123ab\r\n\'=HYPERLINK(),x,Secret123Secret123ab\r\n',
	);
});

test("the sample file has the import columns as its header", () => {
	expect(SAMPLE_IMPORT_CSV.split("\r\n")[0]).toBe("name,email,username,role,kind");
});
