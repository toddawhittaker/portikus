import {
	LIVE_HELP_MINUTES,
	type LiveHelpEndReason,
	type LiveHelpStatus,
} from "@portikus/contracts";
import {
	type Database,
	isUniqueViolation,
	recordAudit,
	recordNotification,
} from "@portikus/db";
import { type Kysely, sql } from "kysely";
import { liveHelpAudience, sharesCourseWith } from "../courses/membership.js";
import { clearPreviewLookups } from "../preview/store.js";
import { liveHelpSockets } from "./registry.js";

/** Title of the notice an instructor gets when a student starts live help. */
export const LIVE_HELP_STARTED_TITLE = "A student asked for live help";

/** Run `work` in a transaction, or in the caller's when it already holds one. */
async function inTransaction<T>(
	db: Kysely<Database>,
	work: (trx: Kysely<Database>) => Promise<T>,
): Promise<T> {
	if (db.isTransaction) return work(db);
	return db.transaction().execute(work);
}

/** Remove the preview access a session gave its helper (ADR 0063). */
async function dropSessionPreviews(
	db: Kysely<Database>,
	sessionIds: readonly string[],
): Promise<void> {
	if (sessionIds.length === 0) return;
	await db
		.deleteFrom("preview_grants")
		.where("live_help_session_id", "in", sessionIds)
		.execute();
	await db
		.deleteFrom("preview_sessions")
		.where("live_help_session_id", "in", sessionIds)
		.execute();
}

/**
 * Close a workspace's session past its end time. Like a share's expiry it is
 * not audited; the one-open index counts it until `ended_at` is set.
 */
async function expireLiveHelp(
	db: Kysely<Database>,
	workspaceId: string,
): Promise<void> {
	const expired = await inTransaction(db, async (trx) => {
		const rows = await trx
			.updateTable("live_help_sessions")
			.set({ ended_at: sql<string>`ends_at` })
			.where("workspace_id", "=", workspaceId)
			.where("ended_at", "is", null)
			.where("ends_at", "<=", sql<Date>`now()`)
			.returning("id")
			.execute();
		const ids = rows.map((row) => row.id);
		await dropSessionPreviews(trx, ids);
		return ids;
	});
	for (const id of expired) liveHelpSockets.end(id);
}

/**
 * End one open session, audit why and for how long, and close its helper
 * sockets at once (ADR 0063). A session that already ended is left alone.
 */
export async function endLiveHelp(
	db: Kysely<Database>,
	end: { sessionId: string; actor: string; reason: LiveHelpEndReason },
): Promise<void> {
	const ended = await inTransaction(db, async (trx) => {
		const row = await trx
			.updateTable("live_help_sessions")
			.set({ ended_at: sql<string>`now()` })
			.where("id", "=", end.sessionId)
			.where("ended_at", "is", null)
			.returning(["project_id", "started_at", "ended_at"])
			.executeTakeFirst();
		if (!row) return false;
		const endedAt = row.ended_at ? new Date(row.ended_at).getTime() : Date.now();
		// Ids only (ADR 0012).
		await recordAudit(trx, {
			actor: end.actor,
			target: row.project_id,
			action: "project.live_help_ended",
			result: "ok",
			metadata: {
				sessionId: end.sessionId,
				reason: end.reason,
				durationSeconds: Math.max(
					0,
					Math.round((endedAt - new Date(row.started_at).getTime()) / 1000),
				),
			},
		});
		await dropSessionPreviews(trx, [end.sessionId]);
		return true;
	});
	if (!ended) return;
	liveHelpSockets.end(end.sessionId);
	// Cached preview rows would let the helper in for two more seconds.
	clearPreviewLookups();
}

/** The open session of a workspace, if any, for its owner. */
async function openSessionId(
	db: Kysely<Database>,
	workspaceId: string,
): Promise<string | null> {
	const row = await db
		.selectFrom("live_help_sessions")
		.select("id")
		.where("workspace_id", "=", workspaceId)
		.where("ended_at", "is", null)
		.where("ends_at", ">", sql<Date>`now()`)
		.executeTakeFirst();
	return row?.id ?? null;
}

/** End the open session of a project being archived (SPEC.md §5.2). */
export async function endProjectLiveHelp(
	db: Kysely<Database>,
	end: { projectId: string; actor: string },
): Promise<void> {
	const row = await db
		.selectFrom("live_help_sessions")
		.select("id")
		.where("project_id", "=", end.projectId)
		.where("ended_at", "is", null)
		.executeTakeFirst();
	if (!row) return;
	await endLiveHelp(db, { sessionId: row.id, actor: end.actor, reason: "archived" });
}

/** The student's own stop. */
export async function stopLiveHelp(
	db: Kysely<Database>,
	stop: { workspaceId: string; actor: string },
): Promise<void> {
	await expireLiveHelp(db, stop.workspaceId);
	const id = await openSessionId(db, stop.workspaceId);
	if (id)
		await endLiveHelp(db, { sessionId: id, actor: stop.actor, reason: "stopped" });
}

/** The helper leaves; only a helper the gate let through calls this. */
export async function leaveLiveHelp(
	db: Kysely<Database>,
	leave: { sessionId: string; helperId: string },
): Promise<void> {
	await endLiveHelp(db, {
		sessionId: leave.sessionId,
		actor: `user:${leave.helperId}`,
		reason: "helper_left",
	});
}

export type StartResult = "started" | "not_allowed" | "open";

/**
 * Open a session for one project: the helper must teach the course and the
 * student must belong to it (ADR 0063). One session per workspace; typing
 * starts off. The helper is told by a notice.
 */
export async function startLiveHelp(
	db: Kysely<Database>,
	start: {
		workspaceId: string;
		projectId: string;
		projectName: string;
		owner: { id: string; displayName: string };
		helperId: string;
		courseId: string;
	},
): Promise<StartResult> {
	if (start.helperId === start.owner.id) return "not_allowed";
	const allowed = await sharesCourseWith(db, {
		instructorId: start.helperId,
		memberId: start.owner.id,
		courseId: start.courseId,
	});
	if (!allowed) return "not_allowed";
	await expireLiveHelp(db, start.workspaceId);
	try {
		await db.transaction().execute(async (trx) => {
			// The database clock, the one every expiry check compares with.
			const session = await trx
				.insertInto("live_help_sessions")
				.values({
					workspace_id: start.workspaceId,
					project_id: start.projectId,
					helper_user_id: start.helperId,
					course_id: start.courseId,
					ends_at: sql<string>`now() + make_interval(mins => ${LIVE_HELP_MINUTES})`,
				})
				.returning(["id", "ends_at"])
				.executeTakeFirstOrThrow();
			await recordAudit(trx, {
				actor: `user:${start.owner.id}`,
				target: start.projectId,
				action: "project.live_help_started",
				result: "ok",
				metadata: {
					sessionId: session.id,
					helperId: start.helperId,
					contextId: start.courseId,
					endsAt: new Date(session.ends_at).toISOString(),
				},
			});
			await recordNotification(trx, start.helperId, {
				tone: "neutral",
				title: LIVE_HELP_STARTED_TITLE,
				body: `${start.owner.displayName} opened live help on ${start.projectName}.`,
			});
		});
	} catch (error) {
		if (isUniqueViolation(error, "live_help_one_open")) return "open";
		throw error;
	}
	return "started";
}

/**
 * Let the helper type, or stop them. A change closes the helper's sockets so
 * they reconnect in the new mode (ADR 0063). Returns false with no open session.
 */
export async function setLiveHelpTyping(
	db: Kysely<Database>,
	change: { workspaceId: string; actor: string; typing: boolean },
): Promise<boolean> {
	await expireLiveHelp(db, change.workspaceId);
	const id = await openSessionId(db, change.workspaceId);
	if (!id) return false;
	const changed = await db.transaction().execute(async (trx) => {
		const row = await trx
			.updateTable("live_help_sessions")
			.set({ typing: change.typing })
			.where("id", "=", id)
			.where("ended_at", "is", null)
			.where("typing", "!=", change.typing)
			.returning(["project_id"])
			.executeTakeFirst();
		if (!row) return false;
		await recordAudit(trx, {
			actor: change.actor,
			target: row.project_id,
			action: "project.live_help_typing_changed",
			result: "ok",
			metadata: { sessionId: id, typing: change.typing },
		});
		return true;
	});
	if (changed) liveHelpSockets.modeChanged(id);
	return true;
}

/**
 * The student's view: the open session, if any, and who could be asked. A
 * session whose helper no longer shares the course ends here, so the
 * student's poll ends it even with no helper socket open.
 */
export async function liveHelpStatus(
	db: Kysely<Database>,
	workspaceId: string,
	ownerId: string,
): Promise<LiveHelpStatus> {
	await expireLiveHelp(db, workspaceId);
	const audience = await liveHelpAudience(db, ownerId);
	const row = await db
		.selectFrom("live_help_sessions")
		.innerJoin("projects", "projects.id", "live_help_sessions.project_id")
		.innerJoin("users", "users.id", "live_help_sessions.helper_user_id")
		.select([
			"live_help_sessions.id",
			"live_help_sessions.project_id",
			"live_help_sessions.course_id",
			"live_help_sessions.helper_user_id",
			"live_help_sessions.typing",
			"live_help_sessions.started_at",
			"live_help_sessions.ends_at",
			"projects.name",
			"users.display_name",
		])
		.where("live_help_sessions.workspace_id", "=", workspaceId)
		.where("live_help_sessions.ended_at", "is", null)
		.executeTakeFirst();
	if (!row) return { session: null, audience };
	const linked = await sharesCourseWith(db, {
		instructorId: row.helper_user_id,
		memberId: ownerId,
		courseId: row.course_id,
	});
	if (!linked) {
		await endLiveHelp(db, {
			sessionId: row.id,
			actor: "platform",
			reason: "helper_removed",
		});
		return { session: null, audience };
	}
	return {
		session: {
			id: row.id,
			projectId: row.project_id,
			projectName: row.name,
			courseId: row.course_id,
			helper: { userId: row.helper_user_id, displayName: row.display_name },
			typing: row.typing,
			startedAt: new Date(row.started_at).toISOString(),
			endsAt: new Date(row.ends_at).toISOString(),
		},
		audience,
	};
}
