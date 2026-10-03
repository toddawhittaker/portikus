import type { AdminUser, AdminWorkspaceSummary } from "@portikus/contracts";
import { timeAgo } from "../../text.js";
import { sourceText } from "../markers.js";

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

/** The rows the filters leave. Archived rows are hidden unless asked for. */
export function filterAccounts(
	users: AdminUser[],
	filters: AccountFilters,
): AdminUser[] {
	const needle = filters.text.trim().toLowerCase();
	return users.filter((user) => {
		const workspace = user.workspace;
		if (!filters.showArchived && user.markers.archived) return false;
		if (filters.state === "none" && workspace) return false;
		if (filters.state !== "all" && filters.state !== "none") {
			if (workspace?.state !== filters.state) return false;
		}
		if (filters.role !== "all" && user.role !== filters.role) return false;
		if (filters.image !== "all") {
			const current = workspace?.image.current;
			if (filters.image === "current" && current !== true) return false;
			if (filters.image === "older" && current !== false) return false;
		}
		if (needle === "") return true;
		return [
			user.displayName,
			user.email,
			user.preferredUsername,
			sourceText(user.issuer),
			workspace?.label,
			workspace?.id,
		].some((field) => field?.toLowerCase().includes(needle));
	});
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
