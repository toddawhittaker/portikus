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
	signin: "sign-in",
	address: "map-pin",
	settings: "settings",
	shell: "terminal",
};

/**
 * The tabs, in a strip at the top of the admin frame, drawn like the
 * workspace's tab strip. They are links, so each tab has an address. The
 * Root shell tab shows only on a server that offers root shells (ADR 0051).
 */
export function AdminNav({
	tab,
	rootShell,
}: {
	tab: AdminTab | null;
	rootShell: boolean;
}) {
	const tabs = ADMIN_TABS.filter((item) => item !== "shell" || rootShell);
	return (
		<nav aria-label="Administration" className="pk-adminnav">
			{tabs.map((item) => (
				<Link
					key={item}
					to="/admin/$tab"
					params={{ tab: item }}
					data-testid={`admin-tab-${item}`}
					aria-current={item === tab ? "page" : undefined}
					className="pk-tab"
				>
					<Icon name={TAB_ICON[item]} size="sm" />
					<span data-label={ADMIN_TAB_LABEL[item]}>{ADMIN_TAB_LABEL[item]}</span>
				</Link>
			))}
		</nav>
	);
}
