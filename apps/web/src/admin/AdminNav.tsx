import { Icon, type IconName } from "@portikus/ui";
import { Link } from "@tanstack/react-router";
import { ADMIN_TAB_LABEL, ADMIN_TABS, type AdminTab } from "./tabs.js";

const TAB_ICON: Record<AdminTab, IconName> = {
	users: "users",
	health: "activity",
	logs: "list",
	audit: "clipboard-list",
	network: "globe",
	backups: "archive",
	image: "layers",
	certificate: "lock",
	docker: "box",
	settings: "settings",
};

/** The first tab of each group after the first gets a small gap before it. */
const GROUP_START = new Set<AdminTab>(["health", "network"]);

/**
 * The tabs, in the app header to give the tables their height back. They
 * look like the workspace's tabs but are links, so each tab has an address.
 */
export function AdminNav({ tab }: { tab: AdminTab | null }) {
	return (
		<nav aria-label="Administration" className="pk-adminnav">
			{ADMIN_TABS.map((item) => (
				<Link
					key={item}
					to="/admin/$tab"
					params={{ tab: item }}
					data-testid={`admin-tab-${item}`}
					aria-current={item === tab ? "page" : undefined}
					// A narrow bar cuts the label short, so the hover text keeps the full name.
					title={ADMIN_TAB_LABEL[item]}
					className={GROUP_START.has(item) ? "pk-tab pk-adminnav-group" : "pk-tab"}
				>
					<Icon name={TAB_ICON[item]} size="sm" />
					<span className="pk-tab-label">{ADMIN_TAB_LABEL[item]}</span>
				</Link>
			))}
		</nav>
	);
}
