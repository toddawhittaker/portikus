import {
	LIVE_HELP_LAST_ENDED_SECONDS,
	LIVE_HELP_MINUTES,
	LiveHelpEndReason,
	type LiveHelpLastEnded,
	type LiveHelpStatus,
} from "@portikus/contracts";
import {
	type Database,
	isUniqueViolation,
	recordAudit,
	recordNotification,
} from "@portikus/db";
import { type ExpressionBuilder, type Kysely, sql } from "kysely";
import { liveHelpAudience, sharesCourseWith } from "../courses/membership.js";
import { closeBridgesForPreviewSessions } from "../preview/bridge.js";
import { clearPreviewLookups } from "../preview/store.js";
import { liveHelpSockets } from "./registry.js";

/** Title of the notice an instructor gets when a student starts live help. */
export const LIVE_HELP_STARTED_TITLE = "A student asked for live help";

/**
 * A session that has not ended and is not past its end time. One past its
 * end time still holds the one-open slot until expiry sets `ended_at`.
 */
export function whereOpen(eb: ExpressionBuilder<Database, "live_help_sessions">) {
	return eb.and([
		eb("live_help_sessions.ended_at", "is", null),
		eb("live_help_sessions.ends_at", ">", sql<Date>`now()`),
	]);
}

/** Sessions whose rows were just ended, and the preview sessions they took along. */
export interface EndedLiveHelp {
	sessionIds: string[];
	previewSessionIds: string[];
}

const NOTHING_ENDED: EndedLiveHelp = { sessionIds: [], previewSessionIds: [] };

/** Remove the preview access a session gave its helper (ADR 0063). */
async function dropSessionPreviews(
	trx: Kysely<Database>,
	sessionIds: readonly string[],
): Promise<string[]> {
	if (sessionIds.length === 0) return [];
	await trx
		.deleteFrom("preview_grants")
		.where("live_help_session_id", "in", sessionIds)
		.execute();
	const rows = await trx
		.deleteFrom("preview_sessions")
		.where("live_help_session_id", "in", sessionIds)
		.returning("id")
		.execute();
	return rows.map((row) => row.id);
}

/**
 * Close what ended sessions left open in this process: helper sockets,
 * cached preview rows, and bridge forwards. Run only after the rows that
 * ended them are committed, so a rollback never cuts a live session.
 */
export async function closeEndedLiveHelp(ended: EndedLiveHelp): Promise<void> {
	if (ended.sessionIds.length === 0) return;
	for (const id of ended.sessionIds) liveHelpSockets.end(id);
	// Cached preview rows would let the helper in for two more seconds.
	clearPreviewLookups();
	await closeBridgesForPreviewSessions(ended.previewSessionIds);
}

/**
 * Close a workspace's session past its end time. Like a share's expiry it is
 * not audited; the one-open index counts it until `ended_at` is set.
 */
async function expireLiveHelp(
	db: Kysely<Database>,
	workspaceId: string,
): Promise<void> {
	const ended = await db.transaction().execute(async (trx) => {
		const rows = await trx
			.updateTable("live_help_sessions")
			.set({ ended_at: sql<string>`ends_at`, end_reason: "expired" })
			.where("workspace_id", "=", workspaceId)
			.where("ended_at", "is", null)
			.where("ends_at", "<=", sql<Date>`now()`)
			.returning("id")
			.execute();
		const sessionIds = rows.map((row) => row.id);
		return {
			sessionIds,
			previewSessionIds: await dropSessionPreviews(trx, sessionIds),
		};
	});
	await closeEndedLiveHelp(ended);
}

/** End one open session's row and audit why and for how long, inside `trx`. */
async function endRow(
	trx: Kysely<Database>,
	end: { sessionId: string; actor: string; reason: LiveHelpEndReason },
): Promise<EndedLiveHelp> {
	const row = await trx
		.updateTable("live_help_sessions")
		.set({ ended_at: sql<string>`now()`, end_reason: end.reason })
		.where("id", "=", end.sessionId)
		.where(whereOpen)
		.returning(["project_id", "started_at", "ended_at"])
		.executeTakeFirst();
	if (!row) return NOTHING_ENDED;
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
	return {
		sessionIds: [end.sessionId],
		previewSessionIds: await dropSessionPreviews(trx, [end.sessionId]),
	};
}

/**
 * End one open session, audit it, and close its helper sockets and previews
 * at once (ADR 0063). A session that already ended or expired is left alone.
 * Not for use inside a caller's transaction; see `endProjectLiveHelp`.
 */
export async function endLiveHelp(
	db: Kysely<Database>,
	end: { sessionId: string; actor: string; reason: LiveHelpEndReason },
): Promise<void> {
	const ended = await db.transaction().execute((trx) => endRow(trx, end));
	await closeEndedLiveHelp(ended);
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
		.where(whereOpen)
		.executeTakeFirst();
	return row?.id ?? null;
}

/**
 * End the open session of a project being archived (SPEC.md §5.2), inside
 * the archive's transaction. The caller passes the result to
 * `closeEndedLiveHelp` once that transaction commits.
 */
export async function endProjectLiveHelp(
	trx: Kysely<Database>,
	end: { projectId: string; actor: string },
): Promise<EndedLiveHelp> {
	const row = await trx
		.selectFrom("live_help_sessions")
		.select("id")
		.where("project_id", "=", end.projectId)
		.where(whereOpen)
		.executeTakeFirst();
	if (!row) return NOTHING_ENDED;
	return endRow(trx, { sessionId: row.id, actor: end.actor, reason: "archived" });
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
			.where(whereOpen)
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

/** The workspace's session that ended within the last minute, if any. */
async function lastEndedLiveHelp(
	db: Kysely<Database>,
	workspaceId: string,
): Promise<LiveHelpLastEnded | null> {
	const row = await db
		.selectFrom("live_help_sessions")
		.innerJoin("projects", "projects.id", "live_help_sessions.project_id")
		.innerJoin("users", "users.id", "live_help_sessions.helper_user_id")
		.select([
			"live_help_sessions.id",
			"live_help_sessions.end_reason",
			"live_help_sessions.ended_at",
			"projects.name",
			"users.display_name",
		])
		.where("live_help_sessions.workspace_id", "=", workspaceId)
		.where(
			"live_help_sessions.ended_at",
			">",
			sql<Date>`now() - make_interval(secs => ${LIVE_HELP_LAST_ENDED_SECONDS})`,
		)
		.orderBy("live_help_sessions.ended_at", "desc")
		.limit(1)
		.executeTakeFirst();
	const reason = LiveHelpEndReason.safeParse(row?.end_reason);
	if (!row?.ended_at || !reason.success) return null;
	return {
		sessionId: row.id,
		helperDisplayName: row.display_name,
		projectName: row.name,
		reason: reason.data,
		endedAt: new Date(row.ended_at).toISOString(),
	};
}

/**
 * The student's view: the open session, or else why the last one just
 * ended, and with `audience` who could be asked. A session whose helper no
 * longer shares the course ends here, so the student's poll ends it even
 * with no helper socket open.
 */
export async function liveHelpStatus(
	db: Kysely<Database>,
	workspaceId: string,
	ownerId: string,
	options: { audience: boolean },
): Promise<LiveHelpStatus> {
	await expireLiveHelp(db, workspaceId);
	const audience = options.audience ? await liveHelpAudience(db, ownerId) : [];
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
		.where(whereOpen)
		.executeTakeFirst();
	const closed = async (): Promise<LiveHelpStatus> => ({
		session: null,
		lastEnded: await lastEndedLiveHelp(db, workspaceId),
		audience,
	});
	if (!row) return closed();
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
		return closed();
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
		lastEnded: null,
		audience,
	};
}
