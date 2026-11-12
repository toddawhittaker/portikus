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
	Icon,
	LABEL_CLASS,
	Menu,
	MenuItem,
	MenuRoot,
	MenuTrigger,
	TextField,
	Toggletip,
} from "@portikus/ui";
import { useSearch } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { SortAnnouncement, useAnnouncedSort } from "../table/announce.js";
import { revealFocused } from "../table/revealFocus.js";
import { SortHeader } from "../table/SortHeader.js";
import { type SortState, sortText } from "../table/sort.js";
import { AdminSection } from "./AdminSection.js";
import { AddDexUser } from "./DexUserDialogs.js";
import { ROLE_FILTERS } from "./markers.js";
import { useAdminUsers, useAdminUsersPage } from "./queries.js";
import { accountMenuTestId } from "./users/AccountMenu.js";
import { AccountRow, PHONE_HIT, rowButtonId } from "./users/AccountRow.js";
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

const SELECT_CLASS = `${CONTROL_CLASS} cursor-pointer`;
// One width for every filter select, held when the bar is tight.
const SELECT_FIELD_CLASS = `${FIELD_CLASS} w-40 flex-none`;

const ROLE_OPTION: Record<(typeof ROLE_FILTERS)[number], string> = {
	administrator: "Administrator",
	instructor: "Instructor",
	student: "Student",
};

/** One row per account, with its workspace beside it (SPEC.md §20.1). */
export function WorkspacesTab({ currentUserId }: { currentUserId: string }) {
	const [filters, setFilters] = useState<AccountFilters>(NO_FILTERS);
	const [moreFilters, setMoreFilters] = useState(false);
	const activeFilters = [
		filters.role !== NO_FILTERS.role,
		filters.state !== NO_FILTERS.state,
		filters.image !== NO_FILTERS.image,
		filters.showArchived !== NO_FILTERS.showArchived,
	].filter(Boolean).length;
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
				lead: "Everyone who has signed in, with their workspace.",
				text: "Choose a name to start, stop or rebuild a workspace, change its storage or limits, or change the account's role. Nobody can sign up on their own: invite someone before their first sign-in.",
			}}
			count={
				<span data-testid="admin-account-count">
					{total} {total === 1 ? "account" : "accounts"}
				</span>
			}
			actions={
				<>
					{filters.image === "older" ? (
						<Button
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
					<AddPeople dexUsers={users.data?.dexUsers === true} />
				</>
			}
		>
			<div className="pk-toolbar flex flex-wrap items-end gap-3">
				<TextField
					id="admin-filter-text"
					label="Search"
					type="search"
					placeholder="Name, email or workspace"
					className="pk-filter-search w-80 max-w-full"
					data-testid="admin-filter-text"
					value={filters.text}
					onChange={(event) => set({ text: event.target.value })}
				/>
				{/* On a phone the other filters wait behind this button, so the rows start higher. */}
				<Button
					className="pk-filter-toggle"
					iconEnd="chevron-down"
					aria-expanded={moreFilters}
					aria-controls="admin-filter-more"
					onClick={() => setMoreFilters((was) => !was)}
				>
					{activeFilters > 0 ? `Filters (${activeFilters})` : "Filters"}
				</Button>
				<div
					className="pk-filter-more contents"
					id="admin-filter-more"
					data-open={moreFilters ? "" : undefined}
				>
					<div className={SELECT_FIELD_CLASS}>
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
					<div className={SELECT_FIELD_CLASS}>
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
					<div className={SELECT_FIELD_CLASS}>
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
					{/* Centred on the controls' row, not on the labelled fields. */}
					<div className="flex h-[var(--pk-control)] items-center gap-1">
						<Checkbox
							label="Show archived"
							checked={filters.showArchived}
							onChange={(event) => set({ showArchived: event.target.checked })}
						/>
					</div>
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
					{/* A focusable region, so the keyboard can scroll a narrow box to columns with no control in them (SPEC.md section 25.8). */}
					<section
						className="pk-table-wrap min-w-0 flex-1 overflow-clip"
						aria-labelledby="admin-accounts-caption"
						// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must take focus to scroll by keyboard
						tabIndex={0}
						onFocus={revealFocused}
					>
						<table className="pk-table pk-table--stack" data-testid="admin-accounts">
							<caption id="admin-accounts-caption" tabIndex={-1} className="sr-only">
								Accounts and their workspaces,{" "}
								{sortText(ACCOUNT_COLUMN_LABEL[sort.column], sort.direction)}. Choose a
								name to see details.
							</caption>
							<thead>
								<tr>
									<th scope="col">
										<Checkbox
											className={PHONE_HIT}
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
									<SortHeader column="role" label="Role" sort={sort} onSort={sortBy} />
									<SortHeader
										column="workspace"
										label="Workspace"
										sort={sort}
										onSort={sortBy}
									/>
									<SortHeader
										column="activity"
										label="Activity"
										sort={sort}
										onSort={sortBy}
										first="descending"
									/>
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
					</section>
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

/**
 * The ways to add people. One filled action: "Add user…" where the site runs
 * Dex's own passwords (ADR 0028), with Invite and Import in a More menu;
 * otherwise "Invite…", with Import beside it.
 */
function AddPeople({ dexUsers }: { dexUsers: boolean }) {
	const [open, setOpen] = useState<"invite" | "import" | null>(null);
	// A fresh mount per opening, so a dialog never shows the last one's entries.
	const [round, setRound] = useState(0);
	function show(which: "invite" | "import") {
		setRound((n) => n + 1);
		setOpen(which);
	}
	function change(next: boolean) {
		if (!next) setOpen(null);
	}
	return (
		<>
			{dexUsers ? (
				<>
					<AddDexUser />
					<MenuRoot>
						<MenuTrigger asChild>
							<Button data-testid="users-add-more">
								More
								<Icon name="chevron-down" size="sm" />
							</Button>
						</MenuTrigger>
						<Menu label="More ways to add people" align="end">
							<MenuItem testId="invite-user" onSelect={() => show("invite")}>
								Invite…
							</MenuItem>
							<MenuItem testId="import-users" onSelect={() => show("import")}>
								Import from CSV…
							</MenuItem>
						</Menu>
					</MenuRoot>
				</>
			) : (
				<>
					<Button
						variant="primary"
						data-testid="invite-user"
						onClick={() => show("invite")}
					>
						Invite…
					</Button>
					<Button data-testid="import-users" onClick={() => show("import")}>
						Import from CSV…
					</Button>
				</>
			)}
			<InviteUser
				key={`invite-${round}`}
				open={open === "invite"}
				onOpenChange={change}
			/>
			<ImportAccounts
				key={`import-${round}`}
				open={open === "import"}
				onOpenChange={change}
			/>
		</>
	);
}
