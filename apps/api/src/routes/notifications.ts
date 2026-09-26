import { requireUser } from "@portikus/auth";
import {
	ListNotificationsQuery,
	MAX_NOTIFICATIONS_PER_USER,
	type Notification,
	type NotificationList,
	type NotificationTone,
	RecordNotificationRequest,
	UpdateNotificationRequest,
} from "@portikus/contracts";
import type { Database, NotificationsTable } from "@portikus/db";
import type { FastifyInstance } from "fastify";
import type { Kysely, Selectable } from "kysely";
import { z } from "zod";
import type { ServerDeps } from "../server.js";
import { sendError } from "./project-scope.js";

/** How many notifications one user may record per minute before 429. */
export const NOTIFICATION_RECORDS_PER_MINUTE = 30;
const WINDOW_MS = 60_000;

const IdParam = z.object({ id: z.string().uuid() });

function toNotification(row: Selectable<NotificationsTable>): Notification {
	return {
		id: row.id,
		tone: row.tone as NotificationTone,
		title: row.title,
		body: row.body,
		createdAt: row.created_at.toISOString(),
		readAt: row.read_at ? row.read_at.toISOString() : null,
	};
}

async function unreadCount(db: Kysely<Database>, userId: string): Promise<number> {
	const row = await db
		.selectFrom("notifications")
		.select((eb) => eb.fn.countAll<string>().as("n"))
		.where("user_id", "=", userId)
		.where("read_at", "is", null)
		.executeTakeFirstOrThrow();
	return Number(row.n);
}

/**
 * Record one notification for a user and keep only their newest rows
 * (ADR 0033). The API also uses it to tell a student something happened.
 */
export async function recordNotification(
	db: Kysely<Database>,
	userId: string,
	notification: { tone: NotificationTone; title: string; body: string },
): Promise<Selectable<NotificationsTable>> {
	const row = await db
		.insertInto("notifications")
		.values({
			user_id: userId,
			tone: notification.tone,
			title: notification.title,
			body: notification.body,
		})
		.returningAll()
		.executeTakeFirstOrThrow();
	// Keep only this user's newest rows; the worker also prunes by age.
	await db
		.deleteFrom("notifications")
		.where("user_id", "=", userId)
		.where("id", "not in", (eb) =>
			eb
				.selectFrom("notifications")
				.select("id")
				.where("user_id", "=", userId)
				.orderBy("created_at", "desc")
				.orderBy("id", "desc")
				.limit(MAX_NOTIFICATIONS_PER_USER),
		)
		.execute();
	return row;
}

/**
 * The signed-in user's notification history (SPEC.md section 8.5, ADR 0033).
 * Every query is scoped to the caller, so no one can read or change another
 * user's notifications. Titles and bodies are never logged (ADR 0012).
 */
export function registerNotificationRoutes(
	app: FastifyInstance,
	{ db }: ServerDeps,
): void {
	const recordTimes = new Map<string, number[]>();

	function overRecordLimit(userId: string): boolean {
		const now = Date.now();
		const recent = (recordTimes.get(userId) ?? []).filter((at) => now - at < WINDOW_MS);
		const over = recent.length >= NOTIFICATION_RECORDS_PER_MINUTE;
		if (!over) recent.push(now);
		recordTimes.set(userId, recent);
		return over;
	}

	app.get("/me/notifications", async (request, reply) => {
		const user = requireUser(request);
		const query = ListNotificationsQuery.safeParse(request.query ?? {});
		if (!query.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", "Invalid page request");
		}
		const rows = await db
			.selectFrom("notifications")
			.selectAll()
			.where("user_id", "=", user.id)
			.orderBy("created_at", "desc")
			.orderBy("id", "desc")
			.limit(query.data.limit)
			.execute();
		const out: NotificationList = {
			notifications: rows.map(toNotification),
			unreadCount: await unreadCount(db, user.id),
		};
		return out;
	});

	app.post("/me/notifications", async (request, reply) => {
		const user = requireUser(request);
		const body = RecordNotificationRequest.safeParse(request.body ?? {});
		if (!body.success) {
			// The message names no field value, so the text never echoes back.
			return sendError(reply, 400, "VALIDATION_FAILED", "Invalid notification");
		}
		if (overRecordLimit(user.id)) {
			request.log.warn("notification record rate limit reached");
			return sendError(reply, 429, "RATE_LIMITED", "Too many notifications just now.");
		}
		const row = await recordNotification(db, user.id, body.data);
		return reply.status(201).send(toNotification(row));
	});

	app.patch("/me/notifications/:id", async (request, reply) => {
		const user = requireUser(request);
		const params = IdParam.safeParse(request.params);
		const body = UpdateNotificationRequest.safeParse(request.body ?? {});
		if (!params.success || !body.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", "Invalid request");
		}
		// Marking an already-read notification keeps its first read time.
		await db
			.updateTable("notifications")
			.set({ read_at: new Date().toISOString() })
			.where("id", "=", params.data.id)
			.where("user_id", "=", user.id)
			.where("read_at", "is", null)
			.execute();
		const row = await db
			.selectFrom("notifications")
			.selectAll()
			.where("id", "=", params.data.id)
			.where("user_id", "=", user.id)
			.executeTakeFirst();
		if (!row) return sendError(reply, 404, "NOT_FOUND", "Notification not found");
		return toNotification(row);
	});

	app.post("/me/notifications/read-all", async (request, reply) => {
		const user = requireUser(request);
		await db
			.updateTable("notifications")
			.set({ read_at: new Date().toISOString() })
			.where("user_id", "=", user.id)
			.where("read_at", "is", null)
			.execute();
		return reply.status(204).send();
	});

	app.delete("/me/notifications", async (request, reply) => {
		const user = requireUser(request);
		await db.deleteFrom("notifications").where("user_id", "=", user.id).execute();
		return reply.status(204).send();
	});
}
