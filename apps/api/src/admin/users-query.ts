import {
	type AdminUser,
	type AdminUsersQuery,
	type SortDirection,
	type SortKey,
	sortRows,
} from "@portikus/contracts";

const LTI_PREFIX = "lti:";

/** "SSO", or "Course: <platform host>", as the Users table's search reads it. */
function sourceText(issuer: string | null): string {
	if (!issuer?.startsWith(LTI_PREFIX)) return "SSO";
	const platform = issuer.slice(LTI_PREFIX.length);
	try {
		return `Course: ${new URL(platform).host}`;
	} catch {
		return `Course: ${platform}`;
	}
}

function isCourseAccount(user: AdminUser): boolean {
	return user.issuer?.startsWith(LTI_PREFIX) ?? false;
}

function matchesText(user: AdminUser, needle: string): boolean {
	return [
		user.displayName,
		user.email,
		user.preferredUsername,
		sourceText(user.issuer),
		user.workspace?.label,
		user.workspace?.id,
	].some((field) => field?.toLowerCase().includes(needle));
}

function matches(user: AdminUser, query: AdminUsersQuery): boolean {
	const workspace = user.workspace;
	if (query.pending) return Boolean(workspace?.pendingOperation);
	if (!query.archived && user.markers.archived) return false;
	if (query.state === "none" && workspace) return false;
	if (query.state && query.state !== "none" && workspace?.state !== query.state) {
		return false;
	}
	if (query.role && user.role !== query.role) return false;
	if (query.unlinkedCourse && (!isCourseAccount(user) || user.markers.linked)) {
		return false;
	}
	if (query.image) {
		const current = workspace?.image.current;
		if (query.image === "current" && current !== true) return false;
		if (query.image === "older" && current !== false) return false;
	}
	const needle = query.q?.trim().toLowerCase() ?? "";
	return needle === "" || matchesText(user, needle);
}

type Column = NonNullable<AdminUsersQuery["sort"]>;

/** The Role column's words, so the sort reads as the table does. */
function roleKey(user: AdminUser): string {
	if (user.role === "administrator") {
		return user.grantedRole === "administrator"
			? "Administrator (granted)"
			: "Administrator (from SSO)";
	}
	if (user.role === "instructor") {
		return user.grantedRole === "instructor" ? "Instructor (granted)" : "Instructor";
	}
	return "Student";
}

/** Connected now beats any past time, and more connections beat fewer. */
function activityKey(user: AdminUser): number | null {
	const workspace = user.workspace;
	if (!workspace) return null;
	if (workspace.activeConnections > 0) {
		return Number.MAX_SAFE_INTEGER - 1_000_000 + workspace.activeConnections;
	}
	return workspace.lastActiveConnectionAt
		? Date.parse(workspace.lastActiveConnectionAt)
		: null;
}

function sortKey(column: Column, user: AdminUser): SortKey {
	switch (column) {
		case "role":
			return roleKey(user);
		case "workspace":
			return user.workspace
				? (user.workspace.pendingOperation ?? user.workspace.state)
				: null;
		case "activity":
			return activityKey(user);
		case "account":
			return null;
	}
}

function sortUsers(
	users: AdminUser[],
	column: Column,
	direction: SortDirection,
): AdminUser[] {
	if (column === "account") {
		return direction === "ascending" ? users : [...users].reverse();
	}
	return sortRows(users, (user) => sortKey(column, user), direction);
}

/**
 * One page of the Users list. `all` is every account, already marked and in
 * name order with shared emails together, so the markers never depend on
 * the page. Without `limit` the whole matching list returns.
 */
export function queryAdminUsers(
	all: readonly AdminUser[],
	query: AdminUsersQuery,
): { users: AdminUser[]; total: number } {
	const matching = all.filter((user) => matches(user, query));
	const sorted = sortUsers(matching, query.sort ?? "account", query.dir ?? "ascending");
	const offset = query.offset ?? 0;
	const end = query.limit === undefined ? undefined : offset + query.limit;
	return { users: sorted.slice(offset, end), total: sorted.length };
}
