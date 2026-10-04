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

/**
 * The tabs, in a strip at the top of the admin frame, drawn like the
 * workspace's tab strip. They are links, so each tab has an address.
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
					className="pk-tab"
				>
					<Icon name={TAB_ICON[item]} size="sm" />
					<span>{ADMIN_TAB_LABEL[item]}</span>
				</Link>
			))}
		</nav>
	);
}
