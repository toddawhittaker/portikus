import { Link, Navigate, useParams } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { usePageTitle } from "../pageTitle.js";
import { AppHeader } from "../shell/AppHeader.js";
import { gatePath, useMe } from "../useMe.js";
import { focusAdminHeading } from "./AdminSection.js";
import { AuditTab } from "./audit/AuditTab.js";
import { BackupsTab } from "./backups/BackupsTab.js";
import { CertificateTab } from "./certificate/CertificateTab.js";
import { DockerTab } from "./docker/DockerTab.js";
import { HealthTab } from "./health/HealthTab.js";
import { ImageTab } from "./image/ImageTab.js";
import { LogsTab } from "./logs/LogsTab.js";
import { NetworkTab } from "./network/NetworkTab.js";
import { SettingsTab } from "./SettingsTab.js";
import { ADMIN_TABS, type AdminTab, DEFAULT_ADMIN_TAB, isAdminTab } from "./tabs.js";
import { OperationEndToasts } from "./users/operationEnd.js";
import { WorkspacesTab } from "./WorkspacesTab.js";

const TAB_LABEL: Record<AdminTab, string> = {
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
};

/** The first tab of each group after the first gets a thin gap before it. */
const GROUP_START = new Set<AdminTab>(["health", "network"]);

/**
 * The tabs, in the app header to give the tables its height back.
 * Links, not a tab widget, so each tab has an address.
 */
function AdminNav({ tab }: { tab: AdminTab }) {
	return (
		<nav aria-label="Administration" className="pk-adminnav">
			{ADMIN_TABS.map((item) => (
				<Link
					key={item}
					to="/admin/$tab"
					params={{ tab: item }}
					data-testid={`admin-tab-${item}`}
					aria-current={item === tab ? "page" : undefined}
					className={GROUP_START.has(item) ? "ms-4" : undefined}
				>
					{TAB_LABEL[item]}
				</Link>
			))}
		</nav>
	);
}

/** The administration screen. Students never get here (SPEC.md §5.2, §6.4). */
export function AdminPage() {
	const me = useMe();
	const params = useParams({ from: "/admin/$tab" });
	const tab = isAdminTab(params.tab) ? params.tab : DEFAULT_ADMIN_TAB;
	usePageTitle(`${TAB_LABEL[tab]}, Administration`);
	const shownTab = useRef(tab);
	const [tabAnnouncement, setTabAnnouncement] = useState("");
	// A link inside one tab that opens another (a chart bar, "View logs") is
	// gone once the tab switches; put focus on the new tab's heading.
	useEffect(() => {
		if (shownTab.current === tab) return;
		shownTab.current = tab;
		// The back button changes the tab without moving focus; say which tab is now open (SPEC.md section 25.8).
		setTabAnnouncement(`${TAB_LABEL[tab]} tab`);
		const lost = !document.activeElement || document.activeElement === document.body;
		if (lost) focusAdminHeading();
	}, [tab]);

	// A gated account is on its way to the gate's page; a second redirect would fight it.
	if (me.status === "loading" || gatePath(me) !== null) {
		return <div className="pk-root" aria-busy="true" />;
	}
	if (me.status === "anonymous") return <Navigate to="/" />;
	if (me.status === "forbidden") return <Navigate to="/not-authorized" />;
	if (me.user.role !== "administrator") return <Navigate to="/not-authorized" />;

	return (
		<div className="pk-root">
			<AppHeader
				user={me.user}
				workspace={null}
				project={undefined}
				nav={<AdminNav tab={tab} />}
			/>
			<main
				className="flex-1 scroll-pt-16 overflow-auto p-8 [scrollbar-gutter:stable]"
				data-testid="page-admin"
				data-density="compact"
				aria-labelledby="admin-title"
			>
				{/* <main> keeps the scroll, so the scrollbar stays at the window edge (SPEC.md section 20.1).
				    scroll-pt-16 keeps a focused row clear of the sticky table header.
				    The stable gutter keeps tall and short tabs the same width. */}
				<div className="mx-auto w-full max-w-[1440px]" data-testid="admin-content">
					<p aria-live="polite" className="sr-only" data-testid="admin-tab-announce">
						{tabAnnouncement}
					</p>
					{/* Here, above the tabs, so an operation's end is announced on any tab (SPEC.md section 20.1). */}
					<OperationEndToasts />
					{/* The header shows "Administration" and the tabs; the h1 keeps the outline. */}
					<h1 className="sr-only" id="admin-title">
						Administration
					</h1>
					{tab === "users" ? <WorkspacesTab currentUserId={me.user.id} /> : null}
					{tab === "health" ? <HealthTab /> : null}
					{tab === "logs" ? <LogsTab /> : null}
					{tab === "audit" ? <AuditTab /> : null}
					{tab === "network" ? <NetworkTab /> : null}
					{tab === "backups" ? <BackupsTab /> : null}
					{tab === "image" ? <ImageTab /> : null}
					{tab === "certificate" ? <CertificateTab /> : null}
					{tab === "docker" ? <DockerTab /> : null}
					{tab === "settings" ? <SettingsTab /> : null}
				</div>
			</main>
		</div>
	);
}
