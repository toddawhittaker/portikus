/**
 * The admin tabs in reading order: people first, then what to look at, then
 * what to change. Each is the last part of its path, `/admin/<tab>`. Kept
 * apart from AdminPage so the router can check a tab without loading the
 * admin screen.
 */
export const ADMIN_TABS = [
	"users",
	"health",
	"logs",
	"audit",
	"network",
	"backups",
	"image",
	"certificate",
	"docker",
	"settings",
] as const;
export type AdminTab = (typeof ADMIN_TABS)[number];

export const DEFAULT_ADMIN_TAB: AdminTab = "users";

export function isAdminTab(value: unknown): value is AdminTab {
	return ADMIN_TABS.some((tab) => tab === value);
}

/**
 * The tab an older `/admin?tab=<x>` link meant. The Users tab's old value was
 * `workspaces` (ADR 0026); anything unknown opens the first tab.
 */
export function adminTabFromLegacy(value: unknown): AdminTab {
	if (value === "workspaces") return "users";
	return isAdminTab(value) ? value : DEFAULT_ADMIN_TAB;
}
