import { Icon, type IconName } from "@portikus/ui";
import { Link } from "@tanstack/react-router";
import { useEffect, useId, useState } from "react";
import { guardRows, healthProblems } from "./health/HealthTab.js";
import { useHealthGlance } from "./health/queries.js";
import { ADMIN_TAB_GROUPS, ADMIN_TAB_LABEL, type AdminTab } from "./tabs.js";

const TAB_ICON: Record<AdminTab, IconName> = {
	users: "users",
	health: "activity",
	logs: "list",
	audit: "clipboard-list",
	agents: "agent",
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
 * The tabs, as a grouped rail beside the admin content. They are links, so
 * each tab has an address. On a phone the rail folds into one control naming
 * the open tab, which opens the tabs as a grouped list. The Root shell tab shows only on a server that
 * offers root shells (ADR 0051).
 */
export function AdminNav({
	tab,
	rootShell,
}: {
	tab: AdminTab | null;
	rootShell: boolean;
}) {
	const listId = useId();
	const [open, setOpen] = useState(false);
	// A chosen tab closes the phone menu.
	// biome-ignore lint/correctness/useExhaustiveDependencies: closes on a tab change only
	useEffect(() => setOpen(false), [tab]);
	const shown = (item: AdminTab) => item !== "shell" || rootShell;
	const current = tab ?? null;
	const report = useHealthGlance().data;
	const healthMarks = report
		? guardRows(report.guard).length + healthProblems(report).length
		: 0;
	return (
		<nav
			aria-label="Administration"
			className="pk-adminnav"
			data-open={open ? "" : undefined}
			onKeyDown={(event) => {
				if (event.key === "Escape" && open) {
					setOpen(false);
					document.getElementById(`${listId}-toggle`)?.focus();
				}
			}}
		>
			<button
				type="button"
				id={`${listId}-toggle`}
				className="pk-adminnav-toggle pk-focus-inset"
				aria-expanded={open}
				aria-controls={listId}
				onClick={() => setOpen((was) => !was)}
			>
				{current ? <Icon name={TAB_ICON[current]} /> : <Icon name="help" />}
				<span className="pk-adminnav-toggle-label">
					<span className="sr-only">Section: </span>
					{current ? ADMIN_TAB_LABEL[current] : "Help"}
				</span>
				<Icon name="chevron-down" className="pk-adminnav-chevron" />
			</button>
			<div className="pk-adminnav-list" id={listId}>
				{ADMIN_TAB_GROUPS.filter((group) => group.tabs.some(shown)).map((group) => (
					<div className="pk-adminnav-group" key={group.label}>
						<p className="pk-adminnav-group-label" aria-hidden={true}>
							{group.label}
						</p>
						<div className="pk-adminnav-tabs">
							{group.tabs.filter(shown).map((item) => (
								<Link
									key={item}
									to="/admin/$tab"
									params={{ tab: item }}
									data-testid={`admin-tab-${item}`}
									aria-current={item === tab ? "page" : undefined}
									className="pk-adminnav-link"
								>
									<Icon name={TAB_ICON[item]} />
									<span>{ADMIN_TAB_LABEL[item]}</span>
									{item === "health" && healthMarks > 0 ? (
										<span className="pk-adminnav-mark">
											<span aria-hidden={true}>{healthMarks}</span>
											<span className="sr-only">
												, {healthMarks}{" "}
												{healthMarks === 1 ? "item needs" : "items need"} attention
											</span>
										</span>
									) : null}
								</Link>
							))}
						</div>
					</div>
				))}
			</div>
		</nav>
	);
}
