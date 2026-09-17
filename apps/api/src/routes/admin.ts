import { requireRole, requireUser } from "@portikus/auth";
import {
	type AdminUser,
	type AdminUserList,
	type AdminWorkspaceList,
	type ApiError,
	LogLevel,
	type PlatformSettings,
	Role,
	UpdateAdminUserSettingsRequest,
	UpdatePlatformSettingsRequest,
} from "@portikus/contracts";
import type { Database } from "@portikus/db";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Updateable } from "kysely";
import { z } from "zod";
import type { ServerDeps } from "../server.js";
import { countActive, toWorkspace } from "./workspace-view.js";

const UuidParam = z.object({ id: z.string().uuid() });

/** The settings columns this route may write. */
type SettingsUpdate = Partial<Updateable<Database["settings"]>>;

/** The stored level, or null when it is unset or no longer a level we know. */
function toLogLevel(value: string | null): LogLevel | null {
	if (value === null) return null;
	const parsed = LogLevel.safeParse(value);
	return parsed.success ? parsed.data : null;
}

const adminOnly = { preHandler: requireRole("administrator") };

function sendError(
	reply: FastifyReply,
	statusCode: number,
	code: ApiError["code"],
	message: string,
): void {
	reply.status(statusCode).send({ code, message });
}

/** Shape a users row as the administration pages want it (SPEC.md §5.2). */
function toAdminUser(row: {
	id: string;
	display_name: string;
	email: string | null;
	role: string;
	disabled_at: Date | null;
	shutdown_grace_seconds: number | null;
}): AdminUser {
	return {
		id: row.id,
		displayName: row.display_name,
		email: row.email,
		role: Role.parse(row.role),
		disabledAt: row.disabled_at ? new Date(row.disabled_at).toISOString() : null,
		shutdownGraceSeconds: row.shutdown_grace_seconds,
	};
}

/** Administrator-only views and settings (SPEC.md §5.2, §6.4). */
export function registerAdminRoutes(
	app: FastifyInstance,
	{ db, config }: ServerDeps,
): void {
	app.get("/admin/workspaces", adminOnly, async () => {
		const rows = await db
			.selectFrom("workspaces")
			.selectAll()
			.orderBy("created_at")
			.execute();

		const workspaces = await Promise.all(
			rows.map(async (row) =>
				toWorkspace(
					row as Record<string, unknown>,
					await countActive(db, row.id as string, config),
					config,
				),
			),
		);

		const body: AdminWorkspaceList = { workspaces };
		return body;
	});

	// GET /admin/settings -- the platform-wide grace period.
	app.get("/admin/settings", adminOnly, async (_request, reply) => {
		const row = await db
			.selectFrom("settings")
			.select(["shutdown_grace_seconds", "log_level", "updated_at"])
			.where("id", "=", 1)
			.executeTakeFirst();
		if (!row) {
			return sendError(reply, 404, "NOT_FOUND", "Platform settings are not set yet");
		}
		const body: PlatformSettings = {
			shutdownGraceSeconds: row.shutdown_grace_seconds,
			logLevel: toLogLevel(row.log_level),
			updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
		};
		return body;
	});

	// PUT /admin/settings -- change it; the worker picks it up next sweep.
	app.put("/admin/settings", adminOnly, async (request, reply) => {
		const user = requireUser(request);

		const body = UpdatePlatformSettingsRequest.safeParse(request.body ?? {});
		if (!body.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", body.error.message);
		}

		const before = await db
			.selectFrom("settings")
			.select(["shutdown_grace_seconds", "log_level"])
			.where("id", "=", 1)
			.executeTakeFirst();
		if (!before) {
			return sendError(reply, 404, "NOT_FOUND", "Platform settings are not set yet");
		}

		// Only the fields the request names are written; the rest keep their value.
		const changes: SettingsUpdate = {
			updated_at: new Date().toISOString(),
			updated_by: user.id,
		};
		const audits: { action: string; from: unknown; to: unknown }[] = [];
		if (body.data.shutdownGraceSeconds !== undefined) {
			changes.shutdown_grace_seconds = body.data.shutdownGraceSeconds;
			audits.push({
				action: "settings.shutdown_grace_updated",
				from: before.shutdown_grace_seconds,
				to: body.data.shutdownGraceSeconds,
			});
		}
		if (body.data.logLevel !== undefined) {
			changes.log_level = body.data.logLevel;
			audits.push({
				action: "settings.log_level_updated",
				from: toLogLevel(before.log_level),
				to: body.data.logLevel,
			});
		}

		// The change and its audit rows commit together (SPEC.md §24.11).
		const updated = await db.transaction().execute(async (trx) => {
			const row = await trx
				.updateTable("settings")
				.set(changes)
				.where("id", "=", 1)
				.returning(["shutdown_grace_seconds", "log_level", "updated_at"])
				.executeTakeFirstOrThrow();
			for (const audit of audits) {
				await trx
					.insertInto("audit_events")
					.values({
						actor: `user:${user.id}`,
						target: "settings",
						action: audit.action,
						result: "ok",
						metadata: JSON.stringify({
							from: audit.from,
							to: audit.to,
							ip: request.ip,
							userAgent: request.headers["user-agent"] ?? null,
						}),
					})
					.execute();
			}
			return row;
		});

		const out: PlatformSettings = {
			shutdownGraceSeconds: updated.shutdown_grace_seconds,
			logLevel: toLogLevel(updated.log_level),
			updatedAt: updated.updated_at ? new Date(updated.updated_at).toISOString() : null,
		};
		return out;
	});

	// GET /admin/users
	app.get("/admin/users", adminOnly, async () => {
		const rows = await db
			.selectFrom("users")
			.select([
				"id",
				"display_name",
				"email",
				"role",
				"disabled_at",
				"shutdown_grace_seconds",
			])
			.orderBy("display_name")
			.orderBy("id")
			.execute();

		const body: AdminUserList = { users: rows.map(toAdminUser) };
		return body;
	});

	// PUT /admin/users/:id/settings -- set or clear one user's override.
	app.put("/admin/users/:id/settings", adminOnly, async (request, reply) => {
		const actor = requireUser(request);

		const params = UuidParam.safeParse(request.params);
		if (!params.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", params.error.message);
		}

		const body = UpdateAdminUserSettingsRequest.safeParse(request.body ?? {});
		if (!body.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", body.error.message);
		}

		const before = await db
			.selectFrom("users")
			.select("shutdown_grace_seconds")
			.where("id", "=", params.data.id)
			.executeTakeFirst();
		if (!before) {
			return sendError(reply, 404, "NOT_FOUND", "User not found");
		}

		// The change and its audit row commit together (SPEC.md §24.11).
		const updated = await db.transaction().execute(async (trx) => {
			const row = await trx
				.updateTable("users")
				.set({
					shutdown_grace_seconds: body.data.shutdownGraceSeconds,
					updated_at: new Date().toISOString(),
				})
				.where("id", "=", params.data.id)
				.returning([
					"id",
					"display_name",
					"email",
					"role",
					"disabled_at",
					"shutdown_grace_seconds",
				])
				.executeTakeFirstOrThrow();
			await trx
				.insertInto("audit_events")
				.values({
					actor: `user:${actor.id}`,
					target: params.data.id,
					action: "user.shutdown_grace_updated",
					result: "ok",
					metadata: JSON.stringify({
						from: before.shutdown_grace_seconds,
						to: body.data.shutdownGraceSeconds,
						ip: request.ip,
						userAgent: request.headers["user-agent"] ?? null,
					}),
				})
				.execute();
			return row;
		});

		return toAdminUser(updated);
	});
}
