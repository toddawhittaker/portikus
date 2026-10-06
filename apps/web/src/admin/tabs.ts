/**
 * The admin tabs in reading order: people first, then what to look at, then
 * what to change, and the root shell last. Each is the last part of its path, `/admin/<tab>`. Kept
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
	// One lowercase word, as Caddy's and Vite's page rules expect, and apart
	// from the API's /admin/root-shell.
	"shell",
] as const;
export type AdminTab = (typeof ADMIN_TABS)[number];

/** Each tab's name: its link text in the header and the start of its page title. */
export const ADMIN_TAB_LABEL: Record<AdminTab, string> = {
	users: "Users",
	health: "Health",
	logs: "Logs",
	audit: "Audit",
	network: "Network",
	backups: "Backups",
	image: "Workspace image",
	certificate: "Certificate",
	docker: "Docker",
	settings: "Settings",
	shell: "Root shell",
};

export const DEFAULT_ADMIN_TAB: AdminTab = "users";

/**
 * `/admin/help`, the administrator help. It shares the admin page so the tabs
 * stay in view, but it is not one of the tabs (SPEC.md section 8.6).
 */
export const ADMIN_HELP_TAB = "help";

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
