import {
	type AdminUser,
	type AuditEvent,
	AuditPage,
	type PendingOperation,
} from "@portikus/contracts";
import { useToast } from "@portikus/ui";
import { useEffect, useRef } from "react";
import { request } from "../../api/request.js";
import { auditQueryString } from "../audit/queries.js";
import { useAdminUsersWhilePending } from "../queries.js";

type Operation = Exclude<PendingOperation, "rebuild-reset-docker">;

/** The audit actions that start an operation (SPEC.md sections 16.4, 17.2). */
const REQUESTED = new Set([
	"workspace.rebuild_requested",
	"workspace.docker_reset_requested",
	"workspace.home_replace_requested",
]);

/** The worker's audit actions that end one. */
const OUTCOMES: Record<string, { operation: Operation; ok: boolean }> = {
	"workspace.rebuilt": { operation: "rebuild", ok: true },
	"workspace.rebuild_failed": { operation: "rebuild", ok: false },
	"workspace.docker_reset": { operation: "reset-docker", ok: true },
	"workspace.docker_reset_failed": { operation: "reset-docker", ok: false },
	"workspace.home_replaced": { operation: "replace-home", ok: true },
	"workspace.home_replace_failed": { operation: "replace-home", ok: false },
};

export type OperationOutcome = {
	operation: Operation;
	ok: boolean;
	/** The error code, or for Replace home the worker's error text. */
	detail: string | null;
};

/**
 * The result of the newest operation, or null while it has none. A result
 * older than the newest request belongs to an earlier operation.
 */
export function operationOutcome(events: AuditEvent[]): OperationOutcome | null {
	const newest = events
		.filter((e) => REQUESTED.has(e.action) || OUTCOMES[e.action])
		.sort((a, b) => b.id - a.id)[0];
	const known = newest ? OUTCOMES[newest.action] : undefined;
	if (!newest || !known) return null;
	// Replace home audits its reason in words; the others audit an error code.
	const detail =
		known.operation === "replace-home"
			? newest.metadata?.error
			: newest.metadata?.errorCode;
	return { ...known, detail: typeof detail === "string" ? detail : null };
}

/** The toast for an outcome; the danger tone makes it an alert for screen readers. */
export function outcomeToast(outcome: OperationOutcome, ownerName: string) {
	const ended = outcome.ok ? "finished" : "failed";
	if (outcome.operation === "replace-home") {
		const title = `Home folder replace for ${ownerName} ${ended}`;
		if (outcome.ok) return { tone: "success" as const, title };
		const reason = outcome.detail
			? `${outcome.detail[0]?.toUpperCase()}${outcome.detail.slice(1)}. `
			: "";
		return {
			tone: "danger" as const,
			title,
			children: `${reason}Look for the error in the Logs tab, then try again from the Backups tab.`,
		};
	}
	const what = outcome.operation === "rebuild" ? "Rebuild" : "Docker reset";
	const title = `${what} of ${ownerName}'s workspace ${ended}`;
	if (outcome.ok) return { tone: "success" as const, title };
	const code = outcome.detail ? ` (${outcome.detail})` : "";
	return {
		tone: "danger" as const,
		title,
		children: `The workspace is in error${code}. Try again, or look for the error in the Logs tab.`,
	};
}

const OPERATION_NAME: Record<Operation, string> = {
	rebuild: "Rebuild",
	"reset-docker": "Docker reset",
	"replace-home": "Home folder replace",
};

/** Failed owners named in a summary before it says "and N more". */
const NAMED_FAILURES = 5;

/** One workspace's operation that has ended, and how. */
export type EndedOperation = { ownerName: string; outcome: OperationOutcome };

/**
 * The toasts for the operations that ended in one poll: each as its own
 * toast when it is the only one of its kind, else one summary per kind, so a
 * bulk rebuild of 40 workspaces is one toast, not 40.
 */
export function endToasts(ended: EndedOperation[]) {
	const byOperation = new Map<Operation, EndedOperation[]>();
	for (const item of ended) {
		const group = byOperation.get(item.outcome.operation) ?? [];
		group.push(item);
		byOperation.set(item.outcome.operation, group);
	}
	return [...byOperation].map(([operation, group]) => {
		const [only] = group;
		if (only && group.length === 1) return outcomeToast(only.outcome, only.ownerName);
		const what = OPERATION_NAME[operation];
		const failed = group
			.filter((item) => !item.outcome.ok)
			.map((item) => item.ownerName);
		const ok = group.length - failed.length;
		if (failed.length === 0) {
			return {
				tone: "success" as const,
				title: `${what} finished for ${ok} workspaces`,
			};
		}
		const shown = failed.slice(0, NAMED_FAILURES).join(", ");
		const more =
			failed.length > NAMED_FAILURES
				? ` and ${failed.length - NAMED_FAILURES} more`
				: "";
		return {
			tone: "danger" as const,
			title:
				ok === 0
					? `${what} failed for ${failed.length} workspaces`
					: `${what} finished for ${ok} ${ok === 1 ? "workspace" : "workspaces"}; ${failed.length} failed`,
			children: `Failed: ${shown}${more}. Look for the errors in the Logs tab.`,
		};
	});
}

/** The worker clears an operation and then audits it, so a result can lag a poll. */
export const OUTCOME_RETRY_MS = 5000;
const OUTCOME_TRIES = 6;
/** Pages of audit rows read per operation kind before trying again later. */
const OUTCOME_PAGES = 4;

/** An audit action prefix that matches one operation's request and result rows. */
const ACTION_PREFIX: Record<Operation, string> = {
	rebuild: "workspace.rebuil",
	"reset-docker": "workspace.docker_reset",
	"replace-home": "workspace.home_replace",
};

/** A workspace seen with an operation pending. */
type Watched = { workspaceId: string; ownerName: string; operation: Operation };

function kindOf(pending: PendingOperation): Operation {
	return pending === "rebuild-reset-docker" ? "rebuild" : pending;
}

/**
 * The outcomes of these operations that are audited yet, by workspace. One
 * read per operation kind covers every workspace, newest rows first, paging
 * only until each workspace has its newest row.
 */
export async function readOutcomes(
	watched: Watched[],
): Promise<Map<string, OperationOutcome>> {
	const outcomes = new Map<string, OperationOutcome>();
	const kinds = new Set(watched.map((item) => item.operation));
	for (const kind of kinds) {
		const ids = new Set(
			watched.filter((item) => item.operation === kind).map((item) => item.workspaceId),
		);
		const rows = new Map<string, AuditEvent[]>();
		let before: number | null = null;
		for (let page = 0; page < OUTCOME_PAGES; page++) {
			const result: AuditPage = await request(
				AuditPage,
				`/admin/audit${auditQueryString({ workspace: "", user: "", action: ACTION_PREFIX[kind] }, before)}`,
			);
			for (const event of result.events) {
				if (!event.target || !ids.has(event.target)) continue;
				rows.set(event.target, [...(rows.get(event.target) ?? []), event]);
			}
			before = result.nextBefore;
			if (before === null || rows.size === ids.size) break;
		}
		for (const [workspaceId, events] of rows) {
			const outcome = operationOutcome(events);
			if (outcome) outcomes.set(workspaceId, outcome);
		}
	}
	return outcomes;
}

/**
 * Mounted once by the admin page, so the end is announced on every tab,
 * such as Backups after a Replace home. Renders nothing.
 */
export function OperationEndToasts() {
	useOperationEndToasts(useAdminUsersWhilePending().data?.users);
	return null;
}

/**
 * Toast when a rebuild, Reset Docker or Replace home ends, for any workspace
 * in the Users list, whether or not its panel is still open (SPEC.md §20.1).
 */
export function useOperationEndToasts(users: AdminUser[] | undefined) {
	const toast = useToast();
	const pending = useRef(new Map<string, Watched>());
	const alive = useRef(true);
	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
		};
	}, []);

	useEffect(() => {
		if (!users) return;
		const listed = new Map<string, AdminUser>();
		for (const user of users) {
			if (user.workspace) listed.set(user.workspace.id, user);
		}

		async function announce(ended: Watched[]) {
			let waiting = ended;
			for (let attempt = 0; attempt < OUTCOME_TRIES; attempt++) {
				if (attempt > 0) {
					await new Promise((resolve) => setTimeout(resolve, OUTCOME_RETRY_MS));
					// Pending again means a later operation, whose result is not this one's.
					waiting = waiting.filter((item) => !pending.current.has(item.workspaceId));
				}
				if (waiting.length === 0 || !alive.current) return;
				const outcomes = await readOutcomes(waiting).catch(
					() => new Map<string, OperationOutcome>(),
				);
				if (!alive.current) return;
				const done: EndedOperation[] = [];
				for (const item of waiting) {
					const outcome = outcomes.get(item.workspaceId);
					if (outcome) done.push({ ownerName: item.ownerName, outcome });
				}
				for (const shown of endToasts(done)) toast.show(shown);
				waiting = waiting.filter((item) => !outcomes.has(item.workspaceId));
			}
		}

		const ended: Watched[] = [];
		for (const [workspaceId, watched] of pending.current) {
			const user = listed.get(workspaceId);
			if (user?.workspace?.pendingOperation) continue;
			pending.current.delete(workspaceId);
			// A workspace that left the list was deleted; there is nothing to say.
			if (user) ended.push(watched);
		}
		if (ended.length > 0) void announce(ended);
		for (const [workspaceId, user] of listed) {
			const operation = user.workspace?.pendingOperation;
			if (operation) {
				pending.current.set(workspaceId, {
					workspaceId,
					ownerName: user.displayName,
					operation: kindOf(operation),
				});
			}
		}
	}, [users, toast]);
}
