import type { AdminUser, AdminWorkspaceSummary } from "@portikus/contracts";
import {
	Checkbox,
	CONTROL_CLASS,
	type DesiredState,
	FIELD_CLASS,
	LABEL_CLASS,
	StateBadge,
	TextField,
	type WorkspaceState,
} from "@portikus/ui";
import { useState } from "react";
import {
	imageText,
	Markers,
	markerLabels,
	shortIssuer,
	sortAccounts,
} from "./markers.js";
import { useAdminUsers } from "./queries.js";
import { WorkspaceDetail } from "./WorkspaceDetail.js";

const KNOWN_STATES: readonly string[] = [
	"provisioning",
	"starting",
	"running",
	"stopping",
	"stopped",
	"error",
];
const KNOWN_DESIRED: readonly string[] = ["running", "stopped", "restarting"];

export interface AccountFilters {
	text: string;
	/** "all", "none" for accounts with no workspace, or a workspace state. */
	state: string;
	/** "all", "current" or "older". */
	image: string;
	showArchived: boolean;
}

export const NO_FILTERS: AccountFilters = {
	text: "",
	state: "all",
	image: "all",
	showArchived: false,
};

/** The rows the filters leave. Archived rows are hidden unless asked for (Epic 11 brief). */
export function filterAccounts(
	users: AdminUser[],
	filters: AccountFilters,
): AdminUser[] {
	const needle = filters.text.trim().toLowerCase();
	return users.filter((user) => {
		const workspace = user.workspace;
		if (!filters.showArchived && user.markers.archived) return false;
		if (filters.state === "none" && workspace) return false;
		if (filters.state !== "all" && filters.state !== "none") {
			if (workspace?.state !== filters.state) return false;
		}
		if (filters.image !== "all") {
			const current = workspace?.image.current;
			if (filters.image === "current" && current !== true) return false;
			if (filters.image === "older" && current !== false) return false;
		}
		if (needle === "") return true;
		return [
			user.displayName,
			user.email,
			user.preferredUsername,
			workspace?.label,
			workspace?.id,
		].some((field) => field?.toLowerCase().includes(needle));
	});
}

/** "Now", "4 min ago", "3 days ago"; an em dash when there is no time. */
export function timeAgo(iso: string | null | undefined, now: number): string {
	if (!iso) return "—";
	const minutes = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
	if (minutes < 1) return "Just now";
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours} h ago`;
	const days = Math.floor(hours / 24);
	return days === 1 ? "1 day ago" : `${days} days ago`;
}

export function lastActivity(workspace: AdminWorkspaceSummary, now: number): string {
	if (workspace.activeConnections > 0) return "Now";
	return timeAgo(workspace.lastActiveConnectionAt, now);
}

export function storageText(quota: { homeGiB: number; dockerGiB: number }): string {
	return `Home ${quota.homeGiB} GiB · Docker ${quota.dockerGiB} GiB`;
}

/** A state the badge knows is drawn as one; anything newer shows its raw name. */
export function WorkspaceStateBadge({
	state,
	desiredState,
}: {
	state: string;
	desiredState: string;
}) {
	if (!KNOWN_STATES.includes(state)) return <span className="pk-tag">{state}</span>;
	return (
		<StateBadge
			state={state as WorkspaceState}
			desiredState={
				KNOWN_DESIRED.includes(desiredState)
					? (desiredState as DesiredState)
					: undefined
			}
		/>
	);
}

const SELECT_CLASS = `${CONTROL_CLASS} w-44 cursor-pointer`;

/** One row per account, with its workspace beside it (SPEC.md §20.1, issue #302). */
export function WorkspacesTab({ currentUserId }: { currentUserId: string }) {
	const users = useAdminUsers();
	const [filters, setFilters] = useState<AccountFilters>(NO_FILTERS);
	const [selectedId, setSelectedId] = useState<string | null>(null);

	const all = sortAccounts(users.data ?? []);
	const rows = filterAccounts(all, filters);
	const selected = all.find((user) => user.id === selectedId) ?? null;
	const running = all.filter((user) => user.workspace?.state === "running").length;
	const now = Date.now();

	function set(patch: Partial<AccountFilters>) {
		setFilters((current) => ({ ...current, ...patch }));
	}

	return (
		<div className="mt-6 flex flex-col gap-4">
			<p className="pk-text-compact pk-muted m-0">
				{all.length} accounts · {running} running
			</p>
			<div className="flex flex-wrap items-end gap-3">
				<TextField
					id="admin-filter-text"
					label="Search"
					type="search"
					placeholder="Name, email, username or workspace"
					className="w-80"
					data-testid="admin-filter-text"
					value={filters.text}
					onChange={(event) => set({ text: event.target.value })}
				/>
				<div className={FIELD_CLASS}>
					<label className={LABEL_CLASS} htmlFor="admin-filter-state">
						State
					</label>
					<select
						id="admin-filter-state"
						className={SELECT_CLASS}
						data-testid="admin-filter-state"
						value={filters.state}
						onChange={(event) => set({ state: event.target.value })}
					>
						<option value="all">All states</option>
						{KNOWN_STATES.map((state) => (
							<option key={state} value={state}>
								{state[0]?.toUpperCase()}
								{state.slice(1)}
							</option>
						))}
						<option value="none">No workspace</option>
					</select>
				</div>
				<div className={FIELD_CLASS}>
					<label className={LABEL_CLASS} htmlFor="admin-filter-image">
						Image
					</label>
					<select
						id="admin-filter-image"
						className={SELECT_CLASS}
						data-testid="admin-filter-image"
						value={filters.image}
						onChange={(event) => set({ image: event.target.value })}
					>
						<option value="all">All images</option>
						<option value="current">Current</option>
						<option value="older">Older</option>
					</select>
				</div>
				<Checkbox
					className="mb-2"
					label="Show archived"
					checked={filters.showArchived}
					onChange={(event) => set({ showArchived: event.target.checked })}
				/>
				<span className="flex-grow" />
				<span
					className="pk-text-compact pk-muted"
					role="status"
					data-testid="admin-row-count"
				>
					Showing {rows.length} of {all.length}
				</span>
			</div>
			<div className="flex items-start gap-4">
				<div className="min-w-0 flex-1 overflow-x-auto">
					<table className="w-full text-left text-[13px]" data-testid="admin-accounts">
						<caption id="admin-accounts-caption" tabIndex={-1} className="sr-only">
							Accounts and their workspaces. Choose a name to see details.
						</caption>
						<thead>
							<tr className="pk-text-label text-ink-muted">
								<th scope="col" className="py-2 pr-4 font-medium">
									Account
								</th>
								<th scope="col" className="py-2 pr-4 font-medium">
									Issuer
								</th>
								<th scope="col" className="py-2 pr-4 font-medium">
									Workspace
								</th>
								<th scope="col" className="py-2 pr-4 font-medium">
									Last activity
								</th>
								<th scope="col" className="py-2 pr-4 font-medium">
									Last sign-in
								</th>
								<th scope="col" className="py-2 pr-4 font-medium">
									Storage
								</th>
								<th scope="col" className="py-2 pr-4 font-medium">
									Image
								</th>
								<th scope="col" className="py-2 font-medium">
									Connections
								</th>
							</tr>
						</thead>
						<tbody>
							{rows.map((user) => (
								<AccountRow
									key={user.id}
									user={user}
									now={now}
									selected={user.id === selectedId}
									onSelect={() => setSelectedId(user.id)}
								/>
							))}
						</tbody>
					</table>
					{users.isSuccess && rows.length === 0 ? (
						<p className="pk-text-body pk-muted mt-4">No accounts match.</p>
					) : null}
				</div>
				{selected ? (
					<WorkspaceDetail
						key={selected.id}
						user={selected}
						isSelf={selected.id === currentUserId}
						onClose={() => {
							setSelectedId(null);
							// An archived row may be filtered out; fall back to the caption.
							(
								document.getElementById(rowButtonId(selected.id)) ??
								document.getElementById("admin-accounts-caption")
							)?.focus();
						}}
					/>
				) : null}
			</div>
		</div>
	);
}

export function rowButtonId(userId: string): string {
	return `admin-row-open-${userId}`;
}

function AccountRow({
	user,
	now,
	selected,
	onSelect,
}: {
	user: AdminUser;
	now: number;
	selected: boolean;
	onSelect: () => void;
}) {
	const workspace = user.workspace;
	const labels = markerLabels(user.markers);
	return (
		<tr
			className={`border-line border-t align-top ${selected ? "bg-surface-hover" : ""}`}
			aria-current={selected ? "true" : undefined}
			data-testid={`account-row-${user.id}`}
			data-markers={labels.join(",")}
		>
			<td
				className="py-2 pr-4 pl-2"
				// The ink bar marks the selected row without relying on colour (issue #369).
				style={selected ? { boxShadow: "var(--row-current-bar)" } : undefined}
				data-testid={`account-cell-${user.id}`}
			>
				<button
					type="button"
					id={rowButtonId(user.id)}
					className="pk-focus-inset cursor-pointer rounded-sm bg-transparent p-0 text-left font-semibold text-ink"
					aria-label={`Show details for ${user.displayName}, ${user.email ?? user.preferredUsername ?? user.id}`}
					aria-expanded={selected}
					aria-controls={selected ? "workspace-detail" : undefined}
					onClick={onSelect}
				>
					{user.displayName}
				</button>
				<Markers markers={user.markers} />
				<div className="pk-muted">{user.email ?? "—"}</div>
				{user.preferredUsername ? (
					<div className="pk-mono-small pk-muted">{user.preferredUsername}</div>
				) : null}
			</td>
			<td className="py-2 pr-4" title={user.issuer ?? undefined}>
				{shortIssuer(user.issuer)}
			</td>
			<td className="py-2 pr-4">
				{workspace ? (
					<div className="flex flex-col items-start gap-1">
						<span className="pk-mono-small">{workspace.label}</span>
						<WorkspaceStateBadge
							state={workspace.state}
							desiredState={workspace.desiredState}
						/>
					</div>
				) : (
					<span className="pk-muted">No workspace</span>
				)}
			</td>
			<td className="py-2 pr-4">{workspace ? lastActivity(workspace, now) : "—"}</td>
			<td className="py-2 pr-4">{timeAgo(user.lastLoginAt, now)}</td>
			<td className="py-2 pr-4">
				{workspace ? storageText(workspace.quotaConfig) : "—"}
			</td>
			<td className="py-2 pr-4">
				{workspace ? (
					<span className="pk-mono-small">{imageText(workspace.image)}</span>
				) : (
					"—"
				)}
			</td>
			<td className="py-2">{workspace ? workspace.activeConnections : "—"}</td>
		</tr>
	);
}
