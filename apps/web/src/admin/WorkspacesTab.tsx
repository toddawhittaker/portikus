import type { AdminUser, AdminWorkspaceSummary } from "@portikus/contracts";
import {
	Button,
	Checkbox,
	CONTROL_CLASS,
	ConfirmDialog,
	ConfirmDialogRoot,
	type DesiredState,
	FIELD_CLASS,
	LABEL_CLASS,
	StateBadge,
	TextField,
	type WorkspaceState,
} from "@portikus/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { z } from "zod";
import { request } from "../api/request.js";
import {
	imageText,
	Markers,
	markerLabels,
	ROLE_FILTERS,
	roleText,
	sortAccounts,
	sourceText,
} from "./markers.js";
import { useAdminUsers } from "./queries.js";
import { errorText } from "./SettingsTab.js";
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
	/** "all" or a role. */
	role: string;
	showArchived: boolean;
}

export const NO_FILTERS: AccountFilters = {
	text: "",
	state: "all",
	image: "all",
	role: "all",
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
		if (filters.role !== "all" && user.role !== filters.role) return false;
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
			sourceText(user.issuer),
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
	statusRole,
}: {
	state: string;
	desiredState: string;
	/** In a table cell or inside a status wrapper, so it is not its own live region. */
	statusRole?: boolean;
}) {
	if (!KNOWN_STATES.includes(state)) return <span className="pk-tag">{state}</span>;
	return (
		<StateBadge
			state={state as WorkspaceState}
			statusRole={statusRole}
			desiredState={
				KNOWN_DESIRED.includes(desiredState)
					? (desiredState as DesiredState)
					: undefined
			}
		/>
	);
}

const SELECT_CLASS = `${CONTROL_CLASS} w-44 cursor-pointer`;

const ROLE_OPTION: Record<(typeof ROLE_FILTERS)[number], string> = {
	administrator: "Administrator",
	instructor: "Instructor",
	student: "Student",
};

export type BulkAction = "disable" | "enable" | "archive" | "unarchive";

export const BULK_ACTIONS: readonly BulkAction[] = [
	"disable",
	"enable",
	"archive",
	"unarchive",
];

interface BulkCopy {
	button: string;
	/** Fits "Could not <verb> <name>". */
	verb: string;
	title: string;
	confirm: string;
	done: string;
	consequence: string;
	/** The existing single-row route for one account. */
	url: (user: AdminUser) => string;
}

const BULK: Record<BulkAction, BulkCopy> = {
	disable: {
		button: "Disable…",
		verb: "disable",
		title: "Disable",
		confirm: "Disable",
		done: "Disabled",
		consequence:
			"They are signed out everywhere, their previews close, and their workspaces stop. Nothing is deleted.",
		url: (user) => `/admin/users/${user.id}/disable`,
	},
	enable: {
		button: "Enable…",
		verb: "enable",
		title: "Enable",
		confirm: "Enable",
		done: "Enabled",
		consequence: "They can sign in again.",
		url: (user) => `/admin/users/${user.id}/enable`,
	},
	archive: {
		button: "Archive workspace…",
		verb: "archive the workspace of",
		title: "Archive the workspaces of",
		confirm: "Archive",
		done: "Archived the workspace of",
		consequence:
			"Each workspace stops and cannot be started until it is unarchived. Its files stay where they are.",
		url: (user) => `/admin/workspaces/${user.workspace?.id}/archive`,
	},
	unarchive: {
		button: "Unarchive workspace…",
		verb: "unarchive the workspace of",
		title: "Unarchive the workspaces of",
		confirm: "Unarchive",
		done: "Unarchived the workspace of",
		consequence: "Each workspace stays stopped until someone starts it.",
		url: (user) => `/admin/workspaces/${user.workspace?.id}/unarchive`,
	},
};

/** Whether one bulk action does anything for one account. Nobody disables themselves. */
export function bulkApplies(
	action: BulkAction,
	user: AdminUser,
	currentUserId: string,
): boolean {
	switch (action) {
		case "disable":
			return user.disabledAt === null && user.id !== currentUserId;
		case "enable":
			return user.disabledAt !== null;
		case "archive":
			return user.workspace !== null && user.workspace.archivedAt === null;
		case "unarchive":
			return user.workspace !== null && user.workspace.archivedAt !== null;
	}
}

/** "Alice", "Alice and Bob", "Alice, Bob and Carol". */
export function joinNames(names: string[]): string {
	if (names.length <= 1) return names[0] ?? "";
	return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

interface BulkResult {
	action: BulkAction;
	done: string[];
	failed: { id: string; name: string; reason: string }[];
}

/** One row per account, with its workspace beside it (SPEC.md §20.1, issue #302). */
export function WorkspacesTab({ currentUserId }: { currentUserId: string }) {
	const users = useAdminUsers();
	const [filters, setFilters] = useState<AccountFilters>(NO_FILTERS);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());

	const all = sortAccounts(users.data ?? []);
	const rows = filterAccounts(all, filters);
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
			<BulkActions
				rows={checkedRows}
				currentUserId={currentUserId}
				onDone={() => setChecked(new Set())}
			/>
			<div className="flex items-start gap-4">
				<div className="min-w-0 flex-1 overflow-x-auto">
					<table className="w-full text-left text-[13px]" data-testid="admin-accounts">
						<caption id="admin-accounts-caption" tabIndex={-1} className="sr-only">
							Accounts and their workspaces. Choose a name to see details.
						</caption>
						<thead>
							<tr className="pk-text-label text-ink-muted">
								<th scope="col" className="py-2 pr-2 pl-2 font-medium">
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
								<th scope="col" className="py-2 pr-4 font-medium">
									Account
								</th>
								<th scope="col" className="py-2 pr-4 font-medium">
									Role
								</th>
								<th scope="col" className="py-2 pr-4 font-medium">
									Source
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
									checked={checked.has(user.id)}
									onCheck={(on) => toggle(user.id, on)}
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

/**
 * The bar over the table while rows are ticked. Each action calls the
 * existing single-row route once per account (Epic 13.1 T4).
 */
function BulkActions({
	rows,
	currentUserId,
	onDone,
}: {
	rows: AdminUser[];
	currentUserId: string;
	onDone: () => void;
}) {
	const client = useQueryClient();
	const resultRef = useRef<HTMLDivElement>(null);
	// The targets are fixed when the dialog opens, so a refetch cannot change them.
	const [confirming, setConfirming] = useState<{
		action: BulkAction;
		users: AdminUser[];
	} | null>(null);
	const [running, setRunning] = useState(false);
	const [result, setResult] = useState<BulkResult | null>(null);

	const targets = (action: BulkAction) =>
		rows.filter((user) => bulkApplies(action, user, currentUserId));
	const offered = BULK_ACTIONS.filter((action) => targets(action).length > 0);

	async function run(action: BulkAction, users: AdminUser[]) {
		if (running) return;
		setRunning(true);
		const outcome: BulkResult = { action, done: [], failed: [] };
		// One at a time, so each refusal is tied to its row.
		for (const user of users) {
			try {
				await request(z.unknown(), BULK[action].url(user), { method: "POST" });
				outcome.done.push(user.displayName);
			} catch (error) {
				outcome.failed.push({
					id: user.id,
					name: user.displayName,
					reason: errorText(error),
				});
			}
		}
		setRunning(false);
		setConfirming(null);
		setResult(outcome);
		onDone();
		// Refetch once for the whole run, not once per row.
		void client.invalidateQueries({ queryKey: ["admin"] });
		// The bar and the dialog are gone, so focus lands on the summary.
		requestAnimationFrame(() => resultRef.current?.focus());
	}

	return (
		<>
			{rows.length > 0 ? (
				<fieldset
					className="m-0 flex flex-wrap items-center gap-2 border-0 p-0"
					data-testid="bulk-actions"
				>
					<legend className="pk-text-compact float-left mr-2">
						{rows.length} selected
					</legend>
					{offered.map((action) => (
						<Button
							key={action}
							size="sm"
							data-testid={`bulk-${action}`}
							onClick={() => setConfirming({ action, users: targets(action) })}
						>
							{BULK[action].button}
						</Button>
					))}
				</fieldset>
			) : null}
			{/* Stays mounted, so each change to the count is announced. */}
			<span className="sr-only" aria-live="polite" data-testid="bulk-count">
				{rows.length > 0 ? `${rows.length} selected` : ""}
			</span>
			<div role="status" data-testid="bulk-result" ref={resultRef} tabIndex={-1}>
				{result ? <BulkSummary result={result} /> : null}
			</div>
			<ConfirmDialogRoot
				open={confirming !== null}
				onOpenChange={(open) => (open || running ? undefined : setConfirming(null))}
			>
				{confirming ? (
					<ConfirmDialog
						id="bulk-dialog"
						testId="bulk-dialog"
						title={`${BULK[confirming.action].title} ${confirming.users.length} ${confirming.users.length === 1 ? "account" : "accounts"}?`}
						description={
							<>
								<span className="block" data-testid="bulk-dialog-names">
									{joinNames(confirming.users.map((user) => user.displayName))}.
								</span>
								<span className="block">{BULK[confirming.action].consequence}</span>
							</>
						}
						confirmLabel={BULK[confirming.action].confirm}
						pending={running}
						onConfirm={() => void run(confirming.action, confirming.users)}
					/>
				) : null}
			</ConfirmDialogRoot>
		</>
	);
}

function BulkSummary({ result }: { result: BulkResult }) {
	const copy = BULK[result.action];
	return (
		<div className="pk-text-compact flex flex-col gap-1">
			{result.done.length > 0 ? (
				<p className="m-0">
					{copy.done} {joinNames(result.done)}.
				</p>
			) : null}
			{result.failed.length > 0 ? (
				<ul className="m-0 list-none p-0 text-status-error">
					{result.failed.map((failure) => (
						<li key={failure.id}>
							Could not {copy.verb} {failure.name}: {failure.reason}
						</li>
					))}
				</ul>
			) : null}
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
	checked,
	onCheck,
	onSelect,
}: {
	user: AdminUser;
	now: number;
	selected: boolean;
	checked: boolean;
	onCheck: (on: boolean) => void;
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
				className="py-2 pr-2 pl-2"
				// The ink bar marks the selected row without relying on colour (issue #369).
				style={selected ? { boxShadow: "var(--row-current-bar)" } : undefined}
				data-testid={`account-cell-${user.id}`}
			>
				<Checkbox
					label={<span className="sr-only">Select {user.displayName}</span>}
					checked={checked}
					onChange={(event) => onCheck(event.target.checked)}
				/>
			</td>
			<td className="py-2 pr-4">
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
			<td className="py-2 pr-4" data-testid={`account-role-${user.id}`}>
				{roleText(user)}
			</td>
			<td
				className="py-2 pr-4"
				title={user.issuer ?? undefined}
				data-testid={`account-source-${user.id}`}
			>
				{sourceText(user.issuer)}
			</td>
			<td className="py-2 pr-4">
				{workspace ? (
					<div className="flex flex-col items-start gap-1">
						<span className="pk-mono-small">{workspace.label}</span>
						<WorkspaceStateBadge
							state={workspace.state}
							desiredState={workspace.desiredState}
							statusRole={false}
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
