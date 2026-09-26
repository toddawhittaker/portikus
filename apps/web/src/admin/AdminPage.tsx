import { Link, Navigate, useSearch } from "@tanstack/react-router";
import { usePageTitle } from "../pageTitle.js";
import { AppHeader } from "../shell/AppHeader.js";
import { gatePath, useMe } from "../useMe.js";
import { AuditTab } from "./audit/AuditTab.js";
import { HealthTab } from "./health/HealthTab.js";
import { SettingsTab } from "./SettingsTab.js";
import { WorkspacesTab } from "./WorkspacesTab.js";

export const ADMIN_TABS = ["workspaces", "audit", "health", "settings"] as const;
export type AdminTab = (typeof ADMIN_TABS)[number];

const TAB_LABEL: Record<AdminTab, string> = {
	// The address stays ?tab=workspaces so old links keep working (docs/archive/epics/EPIC-13-1.md ruling 24).
	workspaces: "Users",
	audit: "Audit",
	health: "Health",
	settings: "Settings",
};

/** The administration screen. Students never get here (SPEC.md §5.2, §6.4). */
export function AdminPage() {
	const me = useMe();
	const search = useSearch({ from: "/admin" });
	const tab = search.tab ?? "workspaces";
	usePageTitle(`${TAB_LABEL[tab]}, Administration`);

	// A gated account is on its way to the gate's page; a second redirect would fight it.
	if (me.status === "loading" || gatePath(me) !== null) {
		return <div className="pk-root" aria-busy="true" />;
	}
	if (me.status === "anonymous") return <Navigate to="/" />;
	if (me.status === "forbidden") return <Navigate to="/not-authorized" />;
	if (me.user.role !== "administrator") return <Navigate to="/not-authorized" />;

	return (
		<div className="pk-root">
			<AppHeader user={me.user} workspace={null} project={undefined} />
			<main
				className="flex-1 scroll-pt-16 overflow-auto p-8"
				data-testid="page-admin"
				data-density="compact"
				aria-labelledby="admin-title"
			>
				{/* <main> keeps the scroll, so the scrollbar stays at the window edge (EPIC-18 ruling 1).
				    scroll-pt-16 keeps a focused row clear of the sticky table header. */}
				<div className="mx-auto w-full max-w-[1440px]" data-testid="admin-content">
					<h1 className="pk-text-title" id="admin-title">
						Administration
					</h1>
					{/* Links, not a tab widget, so each tab has an address (Epic 11 brief). */}
					<nav
						aria-label="Administration"
						className="mt-4 flex gap-1 border-line border-b"
					>
						{ADMIN_TABS.map((item) => (
							<Link
								key={item}
								to="/admin"
								search={{ tab: item }}
								data-testid={`admin-tab-${item}`}
								aria-current={item === tab ? "page" : undefined}
								className={`pk-focus-ring -mb-px rounded-t-sm border-b-2 px-3 py-2 font-semibold text-[13px] no-underline ${
									item === tab
										? "border-accent text-ink"
										: "border-transparent text-ink-muted hover:text-ink"
								}`}
							>
								{TAB_LABEL[item]}
							</Link>
						))}
					</nav>
					{tab === "workspaces" ? <WorkspacesTab currentUserId={me.user.id} /> : null}
					{tab === "audit" ? <AuditTab /> : null}
					{tab === "health" ? <HealthTab /> : null}
					{tab === "settings" ? <SettingsTab /> : null}
				</div>
			</main>
		</div>
	);
}
