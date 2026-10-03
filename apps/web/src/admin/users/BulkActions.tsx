import type { AdminUser } from "@portikus/contracts";
import { Button, Checkbox, ConfirmDialog, ConfirmDialogRoot } from "@portikus/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { ApiError, errorText, request } from "../../api/request.js";
import { joinWords } from "../../text.js";
import { adminActionUrl } from "../queries.js";

export type BulkAction = "disable" | "enable" | "archive" | "unarchive" | "rebuild";

const BULK_ACTIONS: readonly BulkAction[] = [
	"disable",
	"enable",
	"archive",
	"unarchive",
	"rebuild",
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
		url: (user) => adminActionUrl("users", user.id, "disable"),
	},
	enable: {
		button: "Enable…",
		verb: "enable",
		title: "Enable",
		confirm: "Enable",
		done: "Enabled",
		consequence: "They can sign in again.",
		url: (user) => adminActionUrl("users", user.id, "enable"),
	},
	archive: {
		button: "Archive workspace…",
		verb: "archive the workspace of",
		title: "Archive the workspaces of",
		confirm: "Archive",
		done: "Archived the workspace of",
		consequence:
			"Each workspace stops and cannot be started until it is unarchived. Its files stay where they are.",
		url: (user) => adminActionUrl("workspaces", user.workspace?.id ?? "", "archive"),
	},
	unarchive: {
		button: "Unarchive workspace…",
		verb: "unarchive the workspace of",
		title: "Unarchive the workspaces of",
		confirm: "Unarchive",
		done: "Unarchived the workspace of",
		consequence: "Each workspace stays stopped until someone starts it.",
		url: (user) => adminActionUrl("workspaces", user.workspace?.id ?? "", "unarchive"),
	},
	rebuild: {
		button: "Rebuild workspace…",
		verb: "rebuild the workspace of",
		title: "Rebuild",
		confirm: "Rebuild",
		done: "Rebuild requested for",
		// The dialog builds its own text for Rebuild; see RebuildDescription.
		consequence: "",
		url: (user) => `/admin/workspaces/${user.workspace?.id ?? ""}/rebuild`,
	},
};

/** The rows "Rebuild all on older images…" acts on (SPEC.md section 20.1). */
export function olderImageTargets(rows: AdminUser[]): AdminUser[] {
	return rows.filter(
		(user) =>
			user.workspace !== null &&
			user.workspace.archivedAt === null &&
			user.workspace.image.current === false,
	);
}

/** A 409 means another operation already waits or runs, so the row is skipped. */
export function bulkOutcome(error: unknown): "skipped" | "failed" {
	return error instanceof ApiError && error.status === 409 ? "skipped" : "failed";
}

/** The names of the targets whose workspace is running and so will restart. */
function runningNames(users: AdminUser[]): string[] {
	return users
		.filter((user) => user.workspace?.state === "running")
		.map((user) => user.displayName);
}

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
		case "rebuild":
			return user.workspace !== null && user.workspace.archivedAt === null;
	}
}

interface BulkResult {
	action: BulkAction;
	done: string[];
	skipped: string[];
	failed: { id: string; name: string; reason: string }[];
}

/** Each opening starts with Reset Docker off (SPEC.md section 20.1). */
export interface BulkConfirm {
	action: BulkAction;
	users: AdminUser[];
	resetDocker: boolean;
	/**
	 * Set when a row's menu opened the dialog: where focus goes after the run,
	 * or null for the summary. A row action leaves the ticked rows alone.
	 */
	returnTo?: () => HTMLElement | null;
}

/**
 * The toolbar row over the table: the filtered count, or the bulk actions
 * while rows are ticked. It keeps one height, so ticking a row never moves
 * the table. Each action calls the existing single-row route once per
 * account.
 */
export function BulkActions({
	rowCount,
	rows,
	currentUserId,
	confirming,
	setConfirming,
	onDone,
}: {
	rowCount: string;
	rows: AdminUser[];
	currentUserId: string;
	confirming: BulkConfirm | null;
	setConfirming: (next: BulkConfirm | null) => void;
	onDone: () => void;
}) {
	const client = useQueryClient();
	const resultRef = useRef<HTMLDivElement>(null);
	const finished = useRef(false);
	const isOpen = confirming !== null;
	// A success from an earlier dialog must not redirect focus when this one is cancelled.
	useEffect(() => {
		if (isOpen) finished.current = false;
	}, [isOpen]);
	const [running, setRunning] = useState(false);
	const [result, setResult] = useState<BulkResult | null>(null);

	const targets = (action: BulkAction) =>
		rows.filter((user) => bulkApplies(action, user, currentUserId));
	const offered = BULK_ACTIONS.filter((action) => targets(action).length > 0);

	async function run({ action, users, resetDocker, returnTo }: BulkConfirm) {
		if (running) return;
		setRunning(true);
		const outcome: BulkResult = { action, done: [], skipped: [], failed: [] };
		const init: RequestInit =
			action === "rebuild"
				? {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ resetDocker }),
					}
				: { method: "POST" };
		// One at a time, so each refusal is tied to its row.
		for (const user of users) {
			try {
				await request(z.unknown(), BULK[action].url(user), init);
				outcome.done.push(user.displayName);
			} catch (error) {
				if (action === "rebuild" && bulkOutcome(error) === "skipped") {
					outcome.skipped.push(user.displayName);
					continue;
				}
				outcome.failed.push({
					id: user.id,
					name: user.displayName,
					reason: errorText(error),
				});
			}
		}
		// The bar and the dialog are gone, so focus lands on the summary.
		finished.current = true;
		setRunning(false);
		setConfirming(null);
		setResult(outcome);
		if (!returnTo) onDone();
		// Refetch once for the whole run, not once per row.
		void client.invalidateQueries({ queryKey: ["admin"] });
	}

	const countText = rows.length > 0 ? "" : rowCount;

	return (
		<>
			{/* One block, so an empty result adds no gap above the table. */}
			<div className="flex flex-col">
				<div
					className="relative flex min-h-[var(--pk-control)] flex-wrap items-center gap-x-3"
					data-testid="admin-table-toolbar"
				>
					{/* Always mounted, so each new count is announced; out of the flow while
					    empty, so it adds no gap before the hint. */}
					<span
						className={countText ? "pk-text-compact pk-muted" : "sr-only"}
						role="status"
						data-testid="admin-row-count"
					>
						{countText}
					</span>
					{rows.length === 0 ? (
						// The row the bulk buttons take once something is ticked says so meanwhile.
						<span className="pk-text-compact pk-muted" data-testid="bulk-hint">
							Select accounts to act on several at once.
						</span>
					) : null}
					{rows.length > 0 ? (
						<fieldset
							className="m-0 flex min-w-0 flex-wrap items-center gap-2 border-0 p-0"
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
									onClick={() =>
										setConfirming({
											action,
											users: targets(action),
											resetDocker: false,
										})
									}
								>
									{BULK[action].button}
								</Button>
							))}
						</fieldset>
					) : null}
				</div>
				<div role="status" data-testid="bulk-result" ref={resultRef} tabIndex={-1}>
					{result ? <BulkSummary result={result} /> : null}
				</div>
			</div>
			{/* Stays mounted, so each change to the count is announced. */}
			<span className="sr-only" aria-live="polite" data-testid="bulk-count">
				{rows.length > 0 ? `${rows.length} selected` : ""}
			</span>
			<ConfirmDialogRoot
				open={confirming !== null}
				onOpenChange={(open) => (open || running ? undefined : setConfirming(null))}
			>
				{confirming ? (
					<ConfirmDialog
						id="bulk-dialog"
						testId="bulk-dialog"
						title={
							confirming.action === "rebuild"
								? rebuildTitle(confirming.users.length)
								: `${BULK[confirming.action].title} ${confirming.users.length} ${confirming.users.length === 1 ? "account" : "accounts"}?`
						}
						description={
							confirming.action === "rebuild" ? (
								<RebuildDescription
									users={confirming.users}
									resetDocker={confirming.resetDocker}
								/>
							) : (
								<>
									<span className="block" data-testid="bulk-dialog-names">
										{joinWords(confirming.users.map((user) => user.displayName))}.
									</span>
									<span className="block">{BULK[confirming.action].consequence}</span>
								</>
							)
						}
						confirmLabel={BULK[confirming.action].confirm}
						// Enabling and unarchiving take nothing away, so they are not drawn as danger.
						destructive={
							confirming.action !== "enable" && confirming.action !== "unarchive"
						}
						pending={running}
						returnFocusTo={() => {
							if (!finished.current) return null;
							finished.current = false;
							return confirming.returnTo?.() ?? resultRef.current;
						}}
						onConfirm={() => void run(confirming)}
					>
						{confirming.action === "rebuild" ? (
							<Checkbox
								label="Also reset Docker"
								checked={confirming.resetDocker}
								onChange={(event) =>
									setConfirming({ ...confirming, resetDocker: event.target.checked })
								}
							/>
						) : null}
					</ConfirmDialog>
				) : null}
			</ConfirmDialogRoot>
		</>
	);
}

export function rebuildTitle(count: number): string {
	return `Rebuild ${count} ${count === 1 ? "workspace" : "workspaces"}?`;
}

/** The single Rebuild dialog's warning, plus who restarts (SPEC.md §22.3). */
export function rebuildWarning(users: AdminUser[], resetDocker: boolean): string[] {
	const lines = [
		`${joinWords(users.map((user) => user.displayName))}.`,
		`Each workspace is recreated from the current image. System packages installed with sudo apt are lost. Projects and home stay${resetDocker ? "; Docker images and volumes are removed." : ", and so do Docker images and volumes."}`,
	];
	const restarting = runningNames(users);
	if (restarting.length > 0) {
		lines.push(
			`${joinWords(restarting)} ${restarting.length === 1 ? "is" : "are"} running and will restart.`,
		);
	}
	return lines;
}

function RebuildDescription({
	users,
	resetDocker,
}: {
	users: AdminUser[];
	resetDocker: boolean;
}) {
	const [names, ...rest] = rebuildWarning(users, resetDocker);
	return (
		<>
			<span className="block" data-testid="bulk-dialog-names">
				{names}
			</span>
			{rest.map((line) => (
				<span key={line} className="block">
					{line}
				</span>
			))}
		</>
	);
}

function BulkSummary({ result }: { result: BulkResult }) {
	const copy = BULK[result.action];
	return (
		<div className="pk-text-compact flex flex-col gap-1 pt-2">
			{result.done.length > 0 ? (
				<p className="m-0">
					{copy.done} {joinWords(result.done)}.
				</p>
			) : null}
			{result.skipped.length > 0 ? (
				<p className="m-0">
					Skipped {joinWords(result.skipped)}: another operation is already waiting or
					running.
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
