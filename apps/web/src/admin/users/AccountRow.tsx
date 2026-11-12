import type { AdminUser } from "@portikus/contracts";
import { Checkbox } from "@portikus/ui";
import { imageText, Markers, markerLabels, roleText } from "../markers.js";
import { WorkspaceStateBadge } from "../WorkspaceStateBadge.js";
import { AccountMenu } from "./AccountMenu.js";
import type { BulkAction } from "./BulkActions.js";
import { accountActivityText } from "./filters.js";

/** The Account cell's second line: the email, or the username when there is none. */
function accountContact(user: Pick<AdminUser, "email" | "preferredUsername">): string {
	return user.email ?? user.preferredUsername ?? "—";
}

export function rowButtonId(userId: string): string {
	return `admin-row-open-${userId}`;
}

export function AccountRow({
	user,
	now,
	currentUserId,
	selected,
	checked,
	onCheck,
	onSelect,
	onConfirm,
}: {
	user: AdminUser;
	now: number;
	currentUserId: string;
	selected: boolean;
	checked: boolean;
	onCheck: (on: boolean) => void;
	onSelect: () => void;
	onConfirm: (action: BulkAction) => void;
}) {
	const workspace = user.workspace;
	const labels = markerLabels(user.markers, workspace);
	return (
		<tr
			className={`align-middle ${selected ? "pk-row-selected" : ""}`}
			aria-current={selected ? "true" : undefined}
			data-testid={`account-row-${user.id}`}
			data-markers={labels.join(",")}
		>
			<td
				className="py-2"
				// The accent bar marks the selected row without relying on the fill alone.
				style={selected ? { boxShadow: "inset 2px 0 0 var(--accent)" } : undefined}
				data-testid={`account-cell-${user.id}`}
			>
				<Checkbox
					label={<span className="sr-only">Select {user.displayName}</span>}
					checked={checked}
					onChange={(event) => onCheck(event.target.checked)}
				/>
			</td>
			<td className="pk-account-cell py-2 whitespace-normal">
				<div className="pk-cell-stack" data-testid={`account-name-${user.id}`}>
					<span className="pk-cell-primary flex-wrap gap-x-2 gap-y-1">
						<button
							type="button"
							id={rowButtonId(user.id)}
							className="pk-account-open pk-focus-inset cursor-pointer rounded-sm bg-transparent p-0 text-left font-semibold text-ink [overflow-wrap:anywhere]"
							aria-label={`Show details for ${user.displayName}, ${user.email ?? user.preferredUsername ?? user.id}`}
							aria-expanded={selected}
							aria-controls={selected ? "workspace-detail" : undefined}
							onClick={onSelect}
						>
							{user.displayName}
						</button>
						<Markers markers={user.markers} workspace={workspace} />
					</span>
					{/* w-0 min-w-full: the contact fills the column but never widens it; a long
					    address wraps rather than pushing Activity and the menu out. */}
					<span
						className="pk-cell-secondary block w-0 min-w-full [overflow-wrap:anywhere]"
						title={accountContact(user)}
						data-testid={`account-contact-${user.id}`}
					>
						{accountContact(user)}
					</span>
				</div>
			</td>
			<td className="py-2 whitespace-normal" data-testid={`account-role-${user.id}`}>
				<RoleCell text={roleText(user)} />
			</td>
			<td className="py-2">
				{workspace ? (
					<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
						<span className="pk-mono-small">{workspace.label}</span>
						<WorkspaceStateBadge
							state={workspace.state}
							desiredState={workspace.desiredState}
							pendingOperation={workspace.pendingOperation}
							statusRole={false}
						/>
						{workspace.image.current === false ? (
							<span
								className="pk-tag"
								title={imageText(workspace.image)}
								data-testid={`account-image-${user.id}`}
							>
								Old image
							</span>
						) : null}
					</div>
				) : (
					<span className="pk-muted">No workspace</span>
				)}
			</td>
			<td
				className="py-2 whitespace-normal text-[13px] text-ink-muted"
				data-testid={`account-activity-${user.id}`}
			>
				{accountActivityText(user, now)}
			</td>
			<td className="pk-cell-actions py-2">
				<AccountMenu user={user} currentUserId={currentUserId} onConfirm={onConfirm} />
			</td>
		</tr>
	);
}

/** "Administrator (from SSO)": the role on the first line, where it came from under it in the quiet style. */
function RoleCell({ text }: { text: string }) {
	const source = text.match(/^(.*?) (\(.*\))$/);
	if (!source) return text;
	return (
		<span className="pk-cell-stack">
			<span>{source[1]}</span> <span className="pk-cell-secondary">{source[2]}</span>
		</span>
	);
}
