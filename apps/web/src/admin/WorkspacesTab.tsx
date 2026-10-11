import {
	ADMIN_USERS_PAGE_SIZE,
	type AdminUser,
	WorkspaceState,
} from "@portikus/contracts";
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
import { useEffect, useRef, useState } from "react";
import { SortAnnouncement, useAnnouncedSort } from "../table/announce.js";
import { SortHeader } from "../table/SortHeader.js";
import { type SortState, sortText } from "../table/sort.js";
import { AdminSection } from "./AdminSection.js";
import { AddDexUser } from "./DexUserDialogs.js";
import { ROLE_FILTERS } from "./markers.js";
import { useAdminUsers, useAdminUsersPage } from "./queries.js";
import { accountMenuTestId } from "./users/AccountMenu.js";
import { AccountRow, rowButtonId } from "./users/AccountRow.js";
import {
	type BulkAction,
	BulkActions,
	type BulkConfirm,
	olderImageTargets,
} from "./users/BulkActions.js";
import { type AccountFilters, isFiltered, NO_FILTERS } from "./users/filters.js";
import { ImportAccounts } from "./users/ImportAccounts.js";
import { InvitedRows, InviteUser } from "./users/Invitations.js";
import {
	ACCOUNT_COLUMN_LABEL,
	type AccountColumn,
	DEFAULT_ACCOUNT_SORT,
} from "./users/sort.js";
import { WorkspaceDetail } from "./WorkspaceDetail.js";

/** How long typing pauses before the search is sent to the server. */
const SEARCH_DELAY_MS = 250;

const SELECT_CLASS = `${CONTROL_CLASS} w-44 cursor-pointer`;

const ROLE_OPTION: Record<(typeof ROLE_FILTERS)[number], string> = {
	administrator: "Administrator",
	instructor: "Instructor",
	student: "Student",
};

/** One row per account, with its workspace beside it (SPEC.md §20.1). */
export function WorkspacesTab({ currentUserId }: { currentUserId: string }) {
	const [filters, setFilters] = useState<AccountFilters>(NO_FILTERS);
	const { sort, setSort, announcement } = useAnnouncedSort(
		DEFAULT_ACCOUNT_SORT,
		ACCOUNT_COLUMN_LABEL,
	);
	const [page, setPage] = useState(0);
	const [pageAnnouncement, setPageAnnouncement] = useState("");
	const [searchText, setSearchText] = useState(filters.text);
	useEffect(() => {
		const timer = setTimeout(() => setSearchText(filters.text), SEARCH_DELAY_MS);
		return () => clearTimeout(timer);
	}, [filters.text]);
	const sent = { ...filters, text: searchText };
	const users = useAdminUsersPage(sent, sort, {
		offset: page * ADMIN_USERS_PAGE_SIZE,
		limit: ADMIN_USERS_PAGE_SIZE,
	});
	// "Rebuild all on older images" acts on every match, not only this page.
	const olderMatches = useAdminUsersPage(sent, sort, undefined, {
		enabled: filters.image === "older",
	});
	// The Health tab's resource guard list links here with ?user= (ADR 0032).
	const search = useSearch({ strict: false }) as { user?: string };
	const [selectedId, setSelectedId] = useState<string | null>(search.user ?? null);
	const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
	// The targets are fixed when the dialog opens, so a refetch cannot change them.
	const [confirming, setConfirming] = useState<BulkConfirm | null>(null);

	const rows = users.data?.users ?? [];
	const total = users.data?.total ?? 0;
	const pageCount = Math.max(1, Math.ceil(total / ADMIN_USERS_PAGE_SIZE));
	// An open panel can belong to an account on another page; the full list finds it.
	const onPage = rows.find((user) => user.id === selectedId);
	const elsewhere = useAdminUsers({
		poll: false,
		enabled: selectedId !== null && users.isSuccess && !onPage,
	});
	const found = onPage ?? elsewhere.data?.users.find((user) => user.id === selectedId);
	// The panel stays up while a filter moves its row off the page and the list loads.
	const lastOpened = useRef<AdminUser | null>(null);
	if (found) lastOpened.current = found;
	const selected =
		found ?? (lastOpened.current?.id === selectedId ? lastOpened.current : null);
	const now = Date.now();
	// A shrinking list can leave the page past the end.
	useEffect(() => {
		if (users.isSuccess && page >= pageCount) setPage(pageCount - 1);
	}, [users.isSuccess, page, pageCount]);
	// Only rows on screen are acted on, so a filter or page change never hides a target.
	const checkedRows = rows.filter((user) => checked.has(user.id));
	const allChecked = rows.length > 0 && checkedRows.length === rows.length;

	function set(patch: Partial<AccountFilters>) {
		setFilters((current) => ({ ...current, ...patch }));
		setPage(0);
	}

	function sortBy(next: SortState<AccountColumn>) {
		setSort(next);
		setPage(0);
	}

	function goTo(next: number) {
		setPage(next);
		setChecked(new Set());
		const first = next * ADMIN_USERS_PAGE_SIZE + 1;
		const last = Math.min(total, (next + 1) * ADMIN_USERS_PAGE_SIZE);
		setPageAnnouncement(
			`Page ${next + 1} of ${pageCount}, accounts ${first} to ${last} of ${total}`,
		);
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
				text: "Everyone who has signed in, with their workspace. Choose a name to start, stop or rebuild a workspace, change its storage or limits, or change the account's role. Nobody can sign up on their own: invite someone before their first sign-in.",
			}}
			count={<span data-testid="admin-account-count">{total} accounts</span>}
			actions={
				<>
					{filters.image === "older" ? (
						<Button
							size="sm"
							data-testid="rebuild-older"
							disabled={olderImageTargets(olderMatches.data?.users ?? []).length === 0}
							onClick={() =>
								setConfirming({
									action: "rebuild",
									users: olderImageTargets(olderMatches.data?.users ?? []),
									resetDocker: false,
								})
							}
						>
							Rebuild all on older images…
						</Button>
					) : null}
					{/* Only when the site runs Dex's own passwords (ADR 0028). */}
					{users.data?.dexUsers ? <AddDexUser /> : null}
					<InviteUser />
					<ImportAccounts />
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
				// The heading counts the matches; this says how many are on this page (N4).
				rowCount={
					isFiltered(filters) || rows.length < total
						? `Showing ${rows.length} of ${total}`
						: ""
				}
				rows={checkedRows}
				currentUserId={currentUserId}
				confirming={confirming}
				setConfirming={setConfirming}
				onDone={() => setChecked(new Set())}
			/>
			{/* The detail panel sits beside the table where there is room for both, and under it where there is not. */}
			<div className="@container">
				<div className="flex flex-col gap-4 @4xl:flex-row @4xl:items-start">
					{/* Not a scroll container, so the header sticks against <main> (SPEC.md section 20.1). */}
					<div className="pk-table-wrap min-w-0 flex-1 overflow-clip">
						<table className="pk-table" data-testid="admin-accounts">
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
										onSort={sortBy}
									>
										<Toggletip label="Account tags">
											Stale is about the account, never the workspace: no sign-in for 30
											days, or another account with the same email signed in since.
											Linked is a course account joined to an SSO account. Throttled,
											Held and High memory come from the resource guard. Not signed in
											yet is an account made less than 30 days ago that has never signed
											in.
										</Toggletip>
									</SortHeader>
									<SortHeader column="role" label="Role" sort={sort} onSort={sortBy}>
										<Toggletip label="Role">
											From SSO means the role comes from your sign-in provider's groups.
											Granted means an administrator gave it here, and only a granted
											role can be taken away here. Only SSO accounts can be granted a
											role.
										</Toggletip>
									</SortHeader>
									<SortHeader
										column="workspace"
										label="Workspace"
										sort={sort}
										onSort={sortBy}
									>
										<Toggletip label="Old image">
											Old image means the workspace runs an image other than the
											default. Rebuild it to move it to the default image. Projects and
											home stay.
										</Toggletip>
									</SortHeader>
									<SortHeader
										column="activity"
										label="Activity"
										sort={sort}
										onSort={sortBy}
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
								<InvitedRows filters={filters} />
							</tbody>
						</table>
						{users.isSuccess && rows.length === 0 ? (
							<p className="pk-text-body pk-muted p-4">No accounts match.</p>
						) : null}
						{total > ADMIN_USERS_PAGE_SIZE ? (
							<nav
								aria-label="Users pages"
								className="flex items-center justify-end gap-3 p-3"
							>
								<Button
									size="sm"
									data-testid="admin-page-previous"
									aria-disabled={page === 0 ? true : undefined}
									onClick={() => {
										if (page > 0) goTo(page - 1);
									}}
								>
									Previous
								</Button>
								<span className="pk-text-body" data-testid="admin-page-label">
									Page {page + 1} of {pageCount}
								</span>
								<Button
									size="sm"
									data-testid="admin-page-next"
									aria-disabled={page >= pageCount - 1 ? true : undefined}
									onClick={() => {
										if (page < pageCount - 1) goTo(page + 1);
									}}
								>
									Next
								</Button>
							</nav>
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
			<SortAnnouncement text={announcement} testId="admin-sort-announce" />
			<SortAnnouncement text={pageAnnouncement} testId="admin-page-announce" />
		</AdminSection>
	);
}
