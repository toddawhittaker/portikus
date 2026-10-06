import { Navigate, useParams } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { AdminHelp } from "../help/AdminHelp.js";
import { ADMIN_HELP_TITLE } from "../help/titles.js";
import { usePageTitle } from "../pageTitle.js";
import { AppHeader } from "../shell/AppHeader.js";
import { gatePath, useMe } from "../useMe.js";
import { AdminNav } from "./AdminNav.js";
import "./admin-frame.css";
import { focusAdminHeading } from "./AdminSection.js";
import { AuditTab } from "./audit/AuditTab.js";
import { BackupsTab } from "./backups/BackupsTab.js";
import { CertificateTab } from "./certificate/CertificateTab.js";
import { DockerTab } from "./docker/DockerTab.js";
import { HealthTab } from "./health/HealthTab.js";
import { ImageTab } from "./image/ImageTab.js";
import { LogsTab } from "./logs/LogsTab.js";
import { NetworkTab } from "./network/NetworkTab.js";
import { RootShellTab } from "./root-shell/RootShellTab.js";
import { useRootShellStatus } from "./root-shell/status.js";
import { SettingsTab } from "./SettingsTab.js";
import {
	ADMIN_HELP_TAB,
	DEFAULT_ADMIN_TAB,
	isAdminTab,
	ADMIN_TAB_LABEL as TAB_LABEL,
} from "./tabs.js";
import { OperationEndToasts } from "./users/operationEnd.js";
import { WorkspacesTab } from "./WorkspacesTab.js";

/** The administration screen. Students never get here (SPEC.md §5.2, §6.4). */
export function AdminPage() {
	const me = useMe();
	const isAdmin = me.status === "authenticated" && me.user.role === "administrator";
	const rootShell = useRootShellStatus(isAdmin);
	const rootShellOn = rootShell.data?.enabled === true;
	const params = useParams({ from: "/admin/$tab" });
	// The administrator help is not a tab, so no tab is current while it shows.
	const help = params.tab === ADMIN_HELP_TAB;
	const view = help ? null : isAdminTab(params.tab) ? params.tab : DEFAULT_ADMIN_TAB;
	const label = view ? TAB_LABEL[view] : ADMIN_HELP_TITLE;
	usePageTitle(`${label}, Administration`);
	const shownTab = useRef(view);
	const [tabAnnouncement, setTabAnnouncement] = useState("");
	// A link inside one tab that opens another (a chart bar, "View logs") is
	// gone once the tab switches; put focus on the new tab's heading.
	useEffect(() => {
		if (shownTab.current === view) return;
		shownTab.current = view;
		// The back button changes the tab without moving focus; say which tab is now open (SPEC.md section 25.8).
		setTabAnnouncement(view ? `${label} tab` : label);
		const lost = !document.activeElement || document.activeElement === document.body;
		if (lost) focusAdminHeading();
	}, [view, label]);
	const shellTab = view === "shell";

	// A gated account is on its way to the gate's page; a second redirect would fight it.
	if (me.status === "loading" || gatePath(me) !== null) {
		return <div className="pk-root" aria-busy="true" />;
	}
	if (me.status === "anonymous") return <Navigate to="/" />;
	if (me.status === "forbidden") return <Navigate to="/not-authorized" />;
	if (me.user.role !== "administrator") return <Navigate to="/not-authorized" />;

	return (
		// The admin area works down to 768 px, where the tabs wrap; the workspace keeps 1024 (SPEC.md section 20.1).
		<div className="pk-root min-w-[768px]!">
			<AppHeader user={me.user} workspace={null} project={undefined} />
			{/* The frame stays still under the header: the tab strip on top, and only
			    the content under it scrolls, as a workspace pane does (SPEC.md section 20.1). */}
			<div className="pk-adminframe-row">
				<div className="pk-adminframe" data-testid="admin-frame">
					<AdminNav tab={view} rootShell={rootShellOn} />
					<main
						className="pk-adminframe-scroll scroll-pt-16"
						data-testid="page-admin"
						data-density="compact"
						aria-labelledby="admin-title"
					>
						{/* scroll-pt-16 keeps a focused row clear of the sticky table header.
						    The root shells fill the frame instead of scrolling in it. */}
						<div
							className={shellTab ? "flex h-full flex-col" : "px-4 py-6"}
							data-testid="admin-content"
						>
							<p
								aria-live="polite"
								className="sr-only"
								data-testid="admin-tab-announce"
							>
								{tabAnnouncement}
							</p>
							{/* Here, above the tabs, so an operation's end is announced on any tab (SPEC.md section 20.1). */}
							<OperationEndToasts />
							{help ? <AdminHelp titleId="admin-title" /> : null}
							{/* The header shows "Administration"; the h1 keeps the outline. */}
							{view ? (
								<h1 className="sr-only" id="admin-title">
									Administration
								</h1>
							) : null}
							{view === "users" ? <WorkspacesTab currentUserId={me.user.id} /> : null}
							{view === "health" ? <HealthTab /> : null}
							{view === "logs" ? <LogsTab /> : null}
							{view === "audit" ? <AuditTab /> : null}
							{view === "network" ? <NetworkTab /> : null}
							{view === "backups" ? <BackupsTab /> : null}
							{view === "image" ? <ImageTab /> : null}
							{view === "certificate" ? <CertificateTab /> : null}
							{view === "docker" ? <DockerTab /> : null}
							{view === "settings" ? <SettingsTab /> : null}
							<RootShellTab shown={shellTab} status={rootShell} />
						</div>
					</main>
				</div>
			</div>
		</div>
	);
}
