import type { AdminUser } from "@portikus/contracts";
import { expect, test } from "vitest";
import { sortAccounts } from "../markers.js";
import { sortAccountRows, workspaceStateLabel } from "./sort.js";
import { account, NONE, summary } from "./testRows.js";

const ada = account("Ada", summary({ state: "running", activeConnections: 2 }), {
	role: "administrator",
	providerRole: "administrator",
	markers: { ...NONE, duplicateEmail: true },
});
const ben = account(
	"Ben",
	summary({
		state: "stopped",
		desiredState: "stopped",
		lastActiveConnectionAt: "2026-09-30T10:00:00.000Z",
	}),
);
const cy = account("Cy", null, { role: "instructor", providerRole: "instructor" });
const dee = account(
	"Dee",
	summary({
		state: "error",
		lastActiveConnectionAt: "2026-10-01T10:00:00.000Z",
		activeConnections: 0,
	}),
);
// Shares Ada's email, so the name order groups them.
const zed = account("Zed", null, {
	email: "ada@example.edu",
	markers: { ...NONE, duplicateEmail: true },
});
const users = sortAccounts([dee, zed, cy, ben, ada]);

function names(rows: AdminUser[]): string[] {
	return rows.map((user) => user.displayName);
}

test("Account keeps the name order with shared emails together, or reverses it", () => {
	expect(
		names(sortAccountRows(users, { column: "account", direction: "ascending" })),
	).toEqual(["Ada", "Zed", "Ben", "Cy", "Dee"]);
	expect(
		names(sortAccountRows(users, { column: "account", direction: "descending" })),
	).toEqual(["Dee", "Cy", "Ben", "Zed", "Ada"]);
});

test("Role sorts by the role's words, with ties by name", () => {
	expect(
		names(sortAccountRows(users, { column: "role", direction: "ascending" })),
	).toEqual(["Ada", "Cy", "Zed", "Ben", "Dee"]);
});

test("Workspace sorts by the state the badge shows, accounts with none last either way", () => {
	expect(
		names(sortAccountRows(users, { column: "workspace", direction: "ascending" })),
	).toEqual(["Dee", "Ada", "Ben", "Zed", "Cy"]);
	expect(
		names(sortAccountRows(users, { column: "workspace", direction: "descending" })),
	).toEqual(["Ben", "Ada", "Dee", "Zed", "Cy"]);
});

test("Activity puts open workspaces first when descending, then the latest visit", () => {
	expect(
		names(sortAccountRows(users, { column: "activity", direction: "descending" })),
	).toEqual(["Ada", "Dee", "Ben", "Zed", "Cy"]);
	expect(
		names(sortAccountRows(users, { column: "activity", direction: "ascending" })),
	).toEqual(["Ben", "Dee", "Ada", "Zed", "Cy"]);
});

test("the Workspace sort word is the badge's: a pending operation, a move, or the raw state", () => {
	expect(
		workspaceStateLabel(summary({ state: "stopped", desiredState: "running" })),
	).toBe("Starting");
	expect(workspaceStateLabel(summary({ pendingOperation: "rebuild" }))).toBe(
		"Rebuilding…",
	);
	expect(workspaceStateLabel(summary({ state: "hibernating" }))).toBe("hibernating");
});
