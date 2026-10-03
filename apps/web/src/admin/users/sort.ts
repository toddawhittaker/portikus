import {
	type AdminUser,
	type AdminWorkspaceSummary,
	DesiredState,
	WorkspaceState,
} from "@portikus/contracts";
import { resolveWorkspaceState } from "@portikus/ui";
import { PENDING_LABEL } from "../../shell/StatusBar.js";
import { roleText } from "../markers.js";
import { type SortState, sortRows } from "../table/sort.js";

export type AccountColumn = "account" | "role" | "workspace" | "activity";

export const ACCOUNT_COLUMN_LABEL: Record<AccountColumn, string> = {
	account: "Account",
	role: "Role",
	workspace: "Workspace",
	activity: "Activity",
};

/** By name, as the table first opens. */
export const DEFAULT_ACCOUNT_SORT: SortState<AccountColumn> = {
	column: "account",
	direction: "ascending",
};

/** The word the Workspace cell's badge shows, so the column sorts by what is on screen. */
export function workspaceStateLabel(workspace: AdminWorkspaceSummary): string {
	if (workspace.pendingOperation) return PENDING_LABEL[workspace.pendingOperation];
	const known = WorkspaceState.safeParse(workspace.state);
	if (!known.success) return workspace.state;
	return resolveWorkspaceState(
		known.data,
		DesiredState.safeParse(workspace.desiredState).data,
	).label;
}

/**
 * Activity as a number that sorts like the column reads: connected now
 * beats any past time, and more connections beat fewer.
 */
function activityKey(workspace: AdminWorkspaceSummary | null): number | null {
	if (!workspace) return null;
	if (workspace.activeConnections > 0) {
		return Number.MAX_SAFE_INTEGER - 1_000_000 + workspace.activeConnections;
	}
	return workspace.lastActiveConnectionAt
		? Date.parse(workspace.lastActiveConnectionAt)
		: null;
}

/**
 * The accounts in the table's order. `users` arrive by name with shared
 * emails grouped (sortAccounts), so Account just keeps or reverses that,
 * and every other column breaks ties by name.
 */
export function sortAccountRows(
	users: readonly AdminUser[],
	sort: SortState<AccountColumn>,
): AdminUser[] {
	switch (sort.column) {
		case "account":
			return sort.direction === "ascending" ? [...users] : [...users].reverse();
		case "role":
			return sortRows(users, (user) => roleText(user), sort.direction);
		case "workspace":
			return sortRows(
				users,
				(user) => (user.workspace ? workspaceStateLabel(user.workspace) : null),
				sort.direction,
			);
		case "activity":
			return sortRows(users, (user) => activityKey(user.workspace), sort.direction);
	}
}
