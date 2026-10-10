import type { ACCOUNT_SORT_COLUMNS } from "@portikus/contracts";
import type { SortState } from "../../table/sort.js";

export type AccountColumn = (typeof ACCOUNT_SORT_COLUMNS)[number];

export const ACCOUNT_COLUMN_LABEL: Record<AccountColumn, string> = {
	account: "Account",
	role: "Role",
	workspace: "Workspace",
	activity: "Activity",
};

/** By name, as the table first opens. The server does the sorting (SPEC.md section 20.1). */
export const DEFAULT_ACCOUNT_SORT: SortState<AccountColumn> = {
	column: "account",
	direction: "ascending",
};
