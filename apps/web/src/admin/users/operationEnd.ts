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

/** The worker clears an operation and then audits it, so a result can lag a poll. */
export const OUTCOME_RETRY_MS = 5000;
const OUTCOME_TRIES = 6;

async function readOutcome(workspaceId: string): Promise<OperationOutcome | null> {
	const page = await request(
		AuditPage,
		`/admin/audit${auditQueryString({ workspace: workspaceId, user: "", action: "workspace." }, null)}`,
	);
	return operationOutcome(page.events);
}

/**
 * Toast when a rebuild, Reset Docker or Replace home ends, for any workspace
 * in the Users list, whether or not its panel is still open (SPEC.md §20.1).
 */
export function useOperationEndToasts(users: AdminUser[] | undefined) {
	const toast = useToast();
	// Workspaces seen with an operation pending, and their owners' names.
	const pending = useRef(new Map<string, string>());
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

		async function announce(workspaceId: string, ownerName: string) {
			for (let attempt = 0; attempt < OUTCOME_TRIES && alive.current; attempt++) {
				if (attempt > 0) {
					await new Promise((resolve) => setTimeout(resolve, OUTCOME_RETRY_MS));
				}
				const outcome = await readOutcome(workspaceId).catch(() => null);
				if (outcome && alive.current) {
					toast.show(outcomeToast(outcome, ownerName));
					return;
				}
			}
		}

		for (const [workspaceId, ownerName] of pending.current) {
			const user = listed.get(workspaceId);
			if (user?.workspace?.pendingOperation) continue;
			pending.current.delete(workspaceId);
			// A workspace that left the list was deleted; there is nothing to say.
			if (user) void announce(workspaceId, ownerName);
		}
		for (const [workspaceId, user] of listed) {
			if (user.workspace?.pendingOperation) {
				pending.current.set(workspaceId, user.displayName);
			}
		}
	}, [users, toast]);
}
