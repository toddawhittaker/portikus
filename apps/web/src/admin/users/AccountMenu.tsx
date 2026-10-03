import type { AdminUser } from "@portikus/contracts";
import {
	IconButton,
	type IconName,
	Menu,
	MenuItem,
	MenuRoot,
	MenuSeparator,
	MenuTrigger,
} from "@portikus/ui";
import { Fragment } from "react";
import {
	ACTION_LABEL,
	type LifecycleAction,
	lifecycleActions,
	useRunLifecycle,
} from "../workspace-detail/lifecycle.js";
import { type BulkAction, bulkApplies } from "./BulkActions.js";

/** The menu's words for the actions that open the confirm dialog. */
const CONFIRM_LABEL: Record<BulkAction, string> = {
	rebuild: "Rebuild workspace…",
	archive: "Archive workspace…",
	unarchive: "Unarchive workspace…",
	disable: "Disable account…",
	enable: "Enable account…",
};

const CONFIRM_ICON: Record<BulkAction, IconName> = {
	rebuild: "restart",
	archive: "folder",
	unarchive: "folder",
	disable: "lock",
	enable: "lock",
};

const LIFECYCLE_ICON: Record<LifecycleAction, IconName> = {
	start: "play",
	stop: "stop",
	restart: "restart",
};

/** Heaviest last, so a slip of the hand lands on something mild. */
const CONFIRM_GROUPS: readonly (readonly BulkAction[])[] = [
	["rebuild"],
	["archive", "unarchive", "disable", "enable"],
];

/** The menu's groups for one account; empty groups are left out. */
export function accountMenuGroups(
	user: AdminUser,
	currentUserId: string,
): { lifecycle: LifecycleAction[]; confirm: BulkAction[][] } {
	const workspace = user.workspace;
	// An archived workspace cannot start, and a stuck one keeps its rescue (see lifecycleActions).
	const lifecycle =
		workspace && workspace.archivedAt === null
			? lifecycleActions(workspace.state, workspace.desiredState).actions
			: [];
	const confirm = CONFIRM_GROUPS.map((group) =>
		group.filter((action) => bulkApplies(action, user, currentUserId)),
	).filter((group) => group.length > 0);
	return { lifecycle, confirm };
}

export function accountMenuTestId(userId: string): string {
	return `account-menu-${userId}`;
}

/**
 * A row's "more" menu (SPEC.md section 20.1): the detail panel's start, stop
 * and restart, and the same confirmed actions the bulk bar offers, for one
 * account. Radix gives it the menu keyboard and returns focus to the button.
 */
export function AccountMenu({
	user,
	currentUserId,
	onConfirm,
}: {
	user: AdminUser;
	currentUserId: string;
	onConfirm: (action: BulkAction) => void;
}) {
	// Lives in the row, not the menu, so the toast still shows after the menu closes.
	const lifecycle = useRunLifecycle();
	const { lifecycle: actions, confirm } = accountMenuGroups(user, currentUserId);
	const workspace = user.workspace;
	if (actions.length === 0 && confirm.length === 0) return null;
	const label = `Actions for ${user.displayName}`;
	return (
		<MenuRoot>
			<MenuTrigger asChild>
				<IconButton
					icon="more"
					size="sm"
					label={label}
					data-testid={accountMenuTestId(user.id)}
				/>
			</MenuTrigger>
			<Menu label={label}>
				{workspace
					? actions.map((action) => (
							<MenuItem
								key={action}
								icon={LIFECYCLE_ICON[action]}
								disabled={lifecycle.pending !== null}
								testId={`account-menu-${action}`}
								onSelect={() => lifecycle.run(workspace.id, user.displayName, action)}
							>
								{ACTION_LABEL[action]}
							</MenuItem>
						))
					: null}
				{confirm.map((group, index) => (
					<Fragment key={group.join()}>
						{index > 0 || actions.length > 0 ? <MenuSeparator /> : null}
						{group.map((action) => (
							<MenuItem
								key={action}
								icon={CONFIRM_ICON[action]}
								danger={action === "disable" || action === "archive"}
								testId={`account-menu-${action}`}
								onSelect={() => onConfirm(action)}
							>
								{CONFIRM_LABEL[action]}
							</MenuItem>
						))}
					</Fragment>
				))}
			</Menu>
		</MenuRoot>
	);
}
