import type { AdminWorkspaceSummary } from "@portikus/contracts";
import type { SortState } from "../../table/sort.js";
import { timeAgo } from "../../text.js";
import type { AccountColumn } from "./sort.js";

export interface AccountFilters {
	text: string;
	/** "all", "none" for accounts with no workspace, or a workspace state. */
	state: string;
	/** "all", "current" or "older". */
	image: string;
	/** "all" or a role. */
	role: string;
	showArchived: boolean;
}

export const NO_FILTERS: AccountFilters = {
	text: "",
	state: "all",
	image: "all",
	role: "all",
	showArchived: false,
};

/**
 * The query string for the Users list: one page when `page` is given, else
 * the whole filtered list. The server does the filtering and sorting
 * (SPEC.md section 20.1).
 */
export function usersQueryString(
	filters: AccountFilters,
	sort: SortState<AccountColumn>,
	page?: { offset: number; limit: number },
): string {
	const params = new URLSearchParams();
	const text = filters.text.trim();
	if (text !== "") params.set("q", text);
	if (filters.role !== "all") params.set("role", filters.role);
	if (filters.state !== "all") params.set("state", filters.state);
	if (filters.image !== "all") params.set("image", filters.image);
	if (filters.showArchived) params.set("archived", "1");
	params.set("sort", sort.column);
	params.set("dir", sort.direction);
	if (page) {
		params.set("limit", String(page.limit));
		params.set("offset", String(page.offset));
	}
	return params.toString();
}

/** The Activity column: "Now, 2 connections" while connected, else when a browser last connected. */
export function activityText(workspace: AdminWorkspaceSummary, now: number): string {
	const count = workspace.activeConnections;
	if (count > 0) return `Now, ${count} ${count === 1 ? "connection" : "connections"}`;
	return timeAgo(workspace.lastActiveConnectionAt, now);
}

/** True when any filter differs from the defaults. */
export function isFiltered(filters: AccountFilters): boolean {
	return (
		filters.text.trim() !== "" ||
		filters.state !== NO_FILTERS.state ||
		filters.image !== NO_FILTERS.image ||
		filters.role !== NO_FILTERS.role ||
		filters.showArchived !== NO_FILTERS.showArchived
	);
}
