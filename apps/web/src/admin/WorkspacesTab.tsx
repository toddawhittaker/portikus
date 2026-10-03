import { WorkspaceState } from "@portikus/contracts";
import {
	Button,
	Checkbox,
	CONTROL_CLASS,
	FIELD_CLASS,
	LABEL_CLASS,
	TextField,
	Toggletip,
} from "@portikus/ui";
import { useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { AdminSection } from "./AdminSection.js";
import { AddDexUser } from "./DexUserDialogs.js";
import { ROLE_FILTERS, sortAccounts } from "./markers.js";
import { useAdminUsers } from "./queries.js";
import { SortHeader } from "./table/SortHeader.js";
import { type SortState, sortText } from "./table/sort.js";
import { accountMenuTestId } from "./users/AccountMenu.js";
import { AccountRow, rowButtonId } from "./users/AccountRow.js";
import {
	type BulkAction,
	BulkActions,
	type BulkConfirm,
	olderImageTargets,
} from "./users/BulkActions.js";
import {
	type AccountFilters,
	filterAccounts,
	isFiltered,
	NO_FILTERS,
} from "./users/filters.js";
import { useOperationEndToasts } from "./users/operationEnd.js";
import {
	ACCOUNT_COLUMN_LABEL,
	type AccountColumn,
	DEFAULT_ACCOUNT_SORT,
	sortAccountRows,
} from "./users/sort.js";
import { WorkspaceDetail } from "./WorkspaceDetail.js";

const SELECT_CLASS = `${CONTROL_CLASS} w-44 cursor-pointer`;

const ROLE_OPTION: Record<(typeof ROLE_FILTERS)[number], string> = {
	administrator: "Administrator",
	instructor: "Instructor",
	student: "Student",
};

/** One row per account, with its workspace beside it (SPEC.md §20.1). */
export function WorkspacesTab({ currentUserId }: { currentUserId: string }) {
	const users = useAdminUsers();
	// Here, not in the panel, so an operation that ends after the panel closes is still announced.
	useOperationEndToasts(users.data?.users);
	const [filters, setFilters] = useState<AccountFilters>(NO_FILTERS);
	const [sort, setSort] = useState<SortState<AccountColumn>>(DEFAULT_ACCOUNT_SORT);
	// The Health tab's resource guard list links here with ?user= (ADR 0032).
	const search = useSearch({ strict: false }) as { user?: string };
	const [selectedId, setSelectedId] = useState<string | null>(search.user ?? null);
	const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
	// The targets are fixed when the dialog opens, so a refetch cannot change them.
	const [confirming, setConfirming] = useState<BulkConfirm | null>(null);

	const all = sortAccounts(users.data?.users ?? []);
	const rows = sortAccountRows(filterAccounts(all, filters), sort);
	const selected = all.find((user) => user.id === selectedId) ?? null;
	const running = all.filter((user) => user.workspace?.state === "running").length;
	const now = Date.now();
	// Only rows on screen are acted on, so a filter never hides a target.
	const checkedRows = rows.filter((user) => checked.has(user.id));
	const allChecked = rows.length > 0 && checkedRows.length === rows.length;

	function set(patch: Partial<AccountFilters>) {
		setFilters((current) => ({ ...current, ...patch }));
	}

	function toggle(id: string, on: boolean) {
		setChecked((current) => {
			const next = new Set(current);
			if (on) next.add(id);
			else next.delete(id);
			return next;
		});
	}

	/** A row menu's confirmed action: the bulk dialog, for one account. */
	function confirmForRow(userId: string, action: BulkAction) {
		const user = rows.find((row) => row.id === userId);
		if (!user) return;
		// An archived row leaves the table unless archived rows are shown, so focus goes to the summary.
		const leaves = action === "archive" && !filters.showArchived;
		setConfirming({
			action,
			users: [user],
			resetDocker: false,
			returnTo: () =>
				leaves
					? null
					: document.querySelector<HTMLElement>(
							`[data-testid="${accountMenuTestId(userId)}"]`,
						),
		});
	}

	return (
		<AdminSection
			title="Users"
			intro={{
				id: "admin-users",
				helpAnchor: "admin-users",
				text: "Everyone who has signed in, with their workspace. Choose a name to start, stop or rebuild a workspace, change its storage or limits, or change the account's role.",
			}}
			count={
				<span data-testid="admin-account-count">
					{all.length} accounts · {running} running
				</span>
			}
			actions={
				<>
					{filters.image === "older" ? (
						<Button
							size="sm"
							data-testid="rebuild-older"
							disabled={olderImageTargets(rows).length === 0}
							onClick={() =>
								setConfirming({
									action: "rebuild",
									users: olderImageTargets(rows),
									resetDocker: false,
								})
							}
						>
							Rebuild all on older images…
						</Button>
					) : null}
					{/* Only when the site runs Dex's own passwords (ADR 0028). */}
					{users.data?.dexUsers ? <AddDexUser /> : null}
				</>
			}
		>
			<div className="flex flex-wrap items-end gap-3">
				<TextField
					id="admin-filter-text"
					label="Search"
					type="search"
					placeholder="Name, email, username, source or workspace"
					className="w-80"
					data-testid="admin-filter-text"
					value={filters.text}
					onChange={(event) => set({ text: event.target.value })}
				/>
				<div className={FIELD_CLASS}>
					<label className={LABEL_CLASS} htmlFor="admin-filter-role">
						Role
					</label>
					<select
						id="admin-filter-role"
						className={SELECT_CLASS}
						data-testid="admin-filter-role"
						value={filters.role}
						onChange={(event) => set({ role: event.target.value })}
					>
						<option value="all">All roles</option>
						{ROLE_FILTERS.map((role) => (
							<option key={role} value={role}>
								{ROLE_OPTION[role]}
							</option>
						))}
					</select>
				</div>
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
						{WorkspaceState.options.map((state) => (
							<option key={state} value={state}>
								{state[0]?.toUpperCase()}
								{state.slice(1)}
							</option>
						))}
						<option value="none">No workspace</option>
					</select>
				</div>
				<div className={FIELD_CLASS}>
					{/* The help button sits beside the label, never inside it. */}
					{/* -my-1 keeps the 24 px button from pushing this label above its neighbours'. */}
					<div className="-my-1 flex min-w-0 items-center gap-1">
						<label className={LABEL_CLASS} htmlFor="admin-filter-image">
							Image
						</label>
						<Toggletip label="Image filter">
							Choose Older to see who needs a rebuild. A button then rebuilds them all
							at once.
						</Toggletip>
					</div>
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
				{/* Centred on the controls' row, not on the labelled fields. */}
				<div className="flex h-[var(--pk-control)] items-center gap-1">
					<Checkbox
						label="Show archived"
						checked={filters.showArchived}
						onChange={(event) => set({ showArchived: event.target.checked })}
					/>
					<Toggletip label="Show archived">
						Archived workspaces are stopped and cannot start until you unarchive them.
						Their files are kept.
					</Toggletip>
				</div>
			</div>
			<BulkActions
				// The heading already counts everyone; this says what a filter left (N4).
				rowCount={
					isFiltered(filters) || rows.length < all.length
						? `Showing ${rows.length} of ${all.length}`
						: ""
				}
				rows={checkedRows}
				currentUserId={currentUserId}
				confirming={confirming}
				setConfirming={setConfirming}
				onDone={() => setChecked(new Set())}
			/>
			<div className="flex items-start gap-4">
				{/* Not a scroll container, so the header sticks against <main> (SPEC.md section 20.1). */}
				<div className="pk-table-wrap min-w-0 flex-1 overflow-clip">
					<table className="pk-table pk-table--page" data-testid="admin-accounts">
						<caption id="admin-accounts-caption" tabIndex={-1} className="sr-only">
							Accounts and their workspaces,{" "}
							{sortText(ACCOUNT_COLUMN_LABEL[sort.column], sort.direction)}. Choose a
							name to see details.
						</caption>
						<thead>
							<tr>
								<th scope="col">
									<Checkbox
										label={<span className="sr-only">Select all shown accounts</span>}
										checked={allChecked}
										indeterminate={checkedRows.length > 0 && !allChecked}
										onChange={(event) =>
											setChecked(
												event.target.checked
													? new Set(rows.map((user) => user.id))
													: new Set(),
											)
										}
									/>
								</th>
								<SortHeader
									column="account"
									label="Account"
									sort={sort}
									onSort={setSort}
								>
									<Toggletip label="Account tags">
										Stale is about the account, never the workspace: no sign-in for 30
										days, or another account with the same email signed in since. Linked
										is a course account joined to an SSO account. Throttled, Held and
										High memory come from the resource guard. Not signed in yet is an
										account made less than 30 days ago that has never signed in.
									</Toggletip>
								</SortHeader>
								<SortHeader column="role" label="Role" sort={sort} onSort={setSort}>
									<Toggletip label="Role">
										From SSO means the role comes from your sign-in provider's groups.
										Granted means an administrator gave it here, and only a granted role
										can be taken away here. Only SSO accounts can be granted a role.
									</Toggletip>
								</SortHeader>
								<SortHeader
									column="workspace"
									label="Workspace"
									sort={sort}
									onSort={setSort}
								>
									<Toggletip label="Old image">
										Old image means the workspace runs an image other than the default.
										Rebuild it to move it to the default image. Projects and home stay.
									</Toggletip>
								</SortHeader>
								<SortHeader
									column="activity"
									label="Activity"
									sort={sort}
									onSort={setSort}
									first="descending"
								>
									<Toggletip label="Activity">
										Now means the workspace is open, with the number of pages and
										terminals attached to it. Otherwise, how long ago someone last
										opened it.
									</Toggletip>
								</SortHeader>
								<th scope="col" className="pk-cell-actions">
									<span className="sr-only">Actions</span>
								</th>
							</tr>
						</thead>
						<tbody>
							{rows.map((user) => (
								<AccountRow
									key={user.id}
									user={user}
									now={now}
									currentUserId={currentUserId}
									selected={user.id === selectedId}
									checked={checked.has(user.id)}
									onCheck={(on) => toggle(user.id, on)}
									onSelect={() => setSelectedId(user.id)}
									onConfirm={(action) => confirmForRow(user.id, action)}
								/>
							))}
						</tbody>
					</table>
					{users.isSuccess && rows.length === 0 ? (
						<p className="pk-text-body pk-muted p-4">No accounts match.</p>
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
		</AdminSection>
	);
}
