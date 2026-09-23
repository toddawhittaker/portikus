import type { Database } from "@portikus/db";
import { type Kysely, sql } from "kysely";

/** One `preview.denied` row per workspace, user and reason per this window. */
export const PREVIEW_DENIED_WINDOW_MS = 60_000;

/** Why the edge check refused a preview request with 403. */
export type PreviewDeniedReason =
	| "host_mismatch"
	| "port_mismatch"
	| "port_not_allowed"
	| "workspace_missing"
	| "not_owner"
	| "label_mismatch"
	| "invalid_bridge_path";

export interface PreviewDeniedAudit {
	record(input: {
		workspaceId: string;
		userId: string;
		reason: PreviewDeniedReason;
	}): Promise<void>;
}

/**
 * Audit 403 refusals from `/preview/authorize` (SPEC.md §24.11) without a row
 * per request: the first refusal in a window inserts a row, and later ones in
 * the same window add to its `count`. Kept in this process, which the pilot
 * runs one of (ADR 0010).
 */
export function createPreviewDeniedAudit(
	db: Kysely<Database>,
	now: () => number = Date.now,
): PreviewDeniedAudit {
	const windows = new Map<string, { startedAt: number; rowId: Promise<number> }>();

	return {
		async record({ workspaceId, userId, reason }) {
			const at = now();
			for (const [key, window] of windows) {
				if (at - window.startedAt >= PREVIEW_DENIED_WINDOW_MS) windows.delete(key);
			}
			const key = `${workspaceId}:${userId}:${reason}`;
			const open = windows.get(key);
			if (open) {
				const id = await open.rowId;
				// Incremented in SQL so overlapping refusals cannot lose a count.
				await db
					.updateTable("audit_events")
					.set({
						metadata: sql`jsonb_set(metadata, '{count}', to_jsonb((metadata->>'count')::int + 1))`,
					})
					.where("id", "=", id)
					.execute();
				return;
			}
			const rowId = db
				.insertInto("audit_events")
				.values({
					actor: `user:${userId}`,
					target: workspaceId,
					action: "preview.denied",
					result: "denied",
					metadata: JSON.stringify({ reason, workspaceId, count: 1 }),
				})
				.returning("id")
				.executeTakeFirstOrThrow()
				.then((row) => row.id);
			windows.set(key, { startedAt: at, rowId });
			try {
				await rowId;
			} catch (error) {
				// A failed insert must not swallow the next minute of refusals.
				windows.delete(key);
				throw error;
			}
		},
	};
}
