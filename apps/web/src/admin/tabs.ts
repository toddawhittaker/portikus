/**
 * The admin tabs in reading order: people first, then what to look at, then
 * what to change (Epic 25 R1). Kept apart from AdminPage so the router can
 * check `?tab=` without loading the admin screen.
 */
export const ADMIN_TABS = [
	"workspaces",
	"health",
	"logs",
	"audit",
	"network",
	"backups",
	"settings",
] as const;
export type AdminTab = (typeof ADMIN_TABS)[number];
