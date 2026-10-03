import type { AdminUser } from "@portikus/contracts";
import { Checkbox } from "@portikus/ui";
import { imageText, Markers, markerLabels, roleText } from "../markers.js";
import { WorkspaceStateBadge } from "../WorkspaceStateBadge.js";
import { AccountMenu } from "./AccountMenu.js";
import type { BulkAction } from "./BulkActions.js";
import { activityText } from "./filters.js";

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
			className={`align-top ${selected ? "bg-surface-hover" : ""}`}
			aria-current={selected ? "true" : undefined}
			data-testid={`account-row-${user.id}`}
			data-markers={labels.join(",")}
		>
			<td
				className="py-2"
				// The ink bar marks the selected row without relying on colour.
				style={selected ? { boxShadow: "var(--row-current-bar)" } : undefined}
				data-testid={`account-cell-${user.id}`}
			>
				<Checkbox
					label={<span className="sr-only">Select {user.displayName}</span>}
					checked={checked}
					onChange={(event) => onCheck(event.target.checked)}
				/>
			</td>
			<td className="py-2 whitespace-normal">
				<div className="pk-cell-stack" data-testid={`account-name-${user.id}`}>
					<span className="pk-cell-primary flex-wrap gap-x-2 gap-y-1">
						<button
							type="button"
							id={rowButtonId(user.id)}
							className="pk-focus-inset cursor-pointer rounded-sm bg-transparent p-0 text-left font-semibold text-ink [overflow-wrap:anywhere]"
							aria-label={`Show details for ${user.displayName}, ${user.email ?? user.preferredUsername ?? user.id}`}
							aria-expanded={selected}
							aria-controls={selected ? "workspace-detail" : undefined}
							onClick={onSelect}
						>
							{user.displayName}
						</button>
						<Markers markers={user.markers} workspace={workspace} />
					</span>
					{/* w-0 min-w-full: the contact fills the column but never widens it, so a long
					    email truncates instead of pushing Activity and the menu out at 1024 px. */}
					<span
						className="pk-cell-secondary block w-0 min-w-full truncate"
						title={accountContact(user)}
						data-testid={`account-contact-${user.id}`}
					>
						{accountContact(user)}
					</span>
				</div>
			</td>
			<td className="py-2 whitespace-normal" data-testid={`account-role-${user.id}`}>
				{roleText(user)}
			</td>
			<td className="py-2">
				{workspace ? (
					<div className="flex flex-col items-start gap-1">
						<span className="pk-mono-small">{workspace.label}</span>
						<WorkspaceStateBadge
							state={workspace.state}
							desiredState={workspace.desiredState}
							pendingOperation={workspace.pendingOperation}
							statusRole={false}
						/>
						{workspace.image.current === false ? (
							<span
								className="pk-tag pk-tag--warning"
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
				className="py-2 whitespace-normal"
				data-testid={`account-activity-${user.id}`}
			>
				{workspace ? activityText(workspace, now) : "—"}
			</td>
			<td className="pk-cell-actions py-2">
				<AccountMenu user={user} currentUserId={currentUserId} onConfirm={onConfirm} />
			</td>
		</tr>
	);
}
