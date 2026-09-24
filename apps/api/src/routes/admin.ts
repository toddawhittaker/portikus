import {
	grantAdministrator,
	requireRole,
	requireUser,
	revokeAdministrator,
} from "@portikus/auth";
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
import { sql, type Updateable } from "kysely";
import { z } from "zod";
import { accountFlags, groupByEmail } from "../admin/markers.js";
import type { ServerDeps } from "../server.js";
import { loadImageFacts, toWorkspaceSummary } from "./admin-workspaces.js";
import { audit, requestMetadata } from "./start-session.js";
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

/** The users columns the administration pages read. */
const USER_COLUMNS = [
	"id",
	"display_name",
	"email",
	"role",
	"provider_role",
	"granted_role",
	"disabled_at",
	"shutdown_grace_seconds",
	"preferred_username",
	"oidc_issuer",
	"last_login_at",
] as const;

/** The users-row part of an AdminUser; markers and workspace are added by listAdminUsers. */
function toAdminUser(row: {
	id: string;
	display_name: string;
	email: string | null;
	role: string;
	provider_role: string;
	granted_role: string | null;
	disabled_at: Date | null;
	shutdown_grace_seconds: number | null;
	preferred_username: string | null;
	oidc_issuer: string;
	last_login_at: Date | null;
}): Omit<AdminUser, "markers" | "workspace"> {
	return {
		id: row.id,
		displayName: row.display_name,
		email: row.email,
		role: Role.parse(row.role),
		providerRole: Role.parse(row.provider_role),
		// The database check allows only these two values.
		grantedRole: row.granted_role as AdminUser["grantedRole"],
		disabledAt: row.disabled_at ? new Date(row.disabled_at).toISOString() : null,
		shutdownGraceSeconds: row.shutdown_grace_seconds,
		preferredUsername: row.preferred_username,
		issuer: row.oidc_issuer,
		lastLoginAt: row.last_login_at ? new Date(row.last_login_at).toISOString() : null,
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

	/** Every account with its markers and workspace (issue #302). */
	async function listAdminUsers(): Promise<AdminUser[]> {
		const users = await db
			.selectFrom("users")
			.select([...USER_COLUMNS, "created_at"])
			.orderBy("display_name")
			.orderBy("id")
			.execute();
		const workspaces = await db.selectFrom("workspaces").selectAll().execute();
		const links = await db
			.selectFrom("account_links")
			.select("course_user_id")
			.execute();
		const linked = new Set(links.map((row) => row.course_user_id));
		const cutoff = new Date(Date.now() - config.PRESENCE_TTL_SECONDS * 1000);
		const counts = await db
			.selectFrom("workspace_connections")
			.select(["workspace_id", sql<number>`count(*)::int`.as("count")])
			.where("last_seen_at", ">", sql<Date>`${cutoff.toISOString()}::timestamptz`)
			.groupBy("workspace_id")
			.execute();
		const active = new Map(counts.map((row) => [row.workspace_id, row.count]));
		const byOwner = new Map(workspaces.map((row) => [row.owner_user_id, row]));
		const facts = await loadImageFacts(db);
		const defaults = {
			homeGiB: config.WORKSPACE_HOME_SIZE_GIB,
			dockerGiB: config.WORKSPACE_DOCKER_SIZE_GIB,
		};
		const flags = accountFlags(
			users.map((user) => ({
				id: user.id,
				email: user.email,
				lastLoginAt: user.last_login_at ? new Date(user.last_login_at) : null,
			})),
			new Date(),
		);

		return groupByEmail(users).map((user) => {
			const workspace = byOwner.get(user.id);
			const flag = flags.get(user.id) ?? { duplicateEmail: false, stale: false };
			return {
				...toAdminUser(user),
				markers: {
					disabled: user.disabled_at !== null,
					archived: Boolean(workspace?.archived_at),
					linked: linked.has(user.id),
					...flag,
				},
				workspace: workspace
					? toWorkspaceSummary(
							workspace as Record<string, unknown>,
							active.get(workspace.id) ?? 0,
							facts,
							defaults,
						)
					: null,
			};
		});
	}

	/** One account as the list shows it, or null when it does not exist. */
	async function loadAdminUser(id: string): Promise<AdminUser | null> {
		return (await listAdminUsers()).find((user) => user.id === id) ?? null;
	}

	// GET /admin/users -- every account with its markers and workspace (issue #302).
	app.get("/admin/users", adminOnly, async () => {
		const list = await listAdminUsers();
		const body: AdminUserList = { users: list };
		return body;
	});

	// POST /admin/users/:id/disable -- the one platform-side revocation (SPEC.md §20.1).
	app.post("/admin/users/:id/disable", adminOnly, async (request, reply) => {
		const actor = requireUser(request);
		const params = UuidParam.safeParse(request.params);
		if (!params.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", params.error.message);
		}
		const id = params.data.id;
		if (id === actor.id) {
			return sendError(
				reply,
				400,
				"VALIDATION_FAILED",
				"You cannot disable your own account.",
			);
		}
		const before = await db
			.selectFrom("users")
			.select("disabled_at")
			.where("id", "=", id)
			.executeTakeFirst();
		if (!before) {
			return sendError(reply, 404, "NOT_FOUND", "User not found");
		}

		// Every effect and its audit row commit together (SPEC.md §24.11).
		const updated = await db.transaction().execute(async (trx) => {
			// Lock every enabled administrator plus the target, so two administrators
			// disabling each other at once cannot both succeed.
			const locked = await trx
				.selectFrom("users")
				.select(["id", "role", "disabled_at"])
				.where((eb) =>
					eb.or([
						eb("id", "=", id),
						eb.and([eb("role", "=", "administrator"), eb("disabled_at", "is", null)]),
					]),
				)
				.orderBy("id")
				.forUpdate()
				.execute();
			const target = locked.find((user) => user.id === id);
			const otherAdmins = locked.filter(
				(user) =>
					user.id !== id && user.role === "administrator" && user.disabled_at === null,
			);
			if (
				target?.role === "administrator" &&
				target.disabled_at === null &&
				otherAdmins.length === 0
			) {
				return null;
			}
			const now = new Date().toISOString();
			const row = await trx
				.updateTable("users")
				.set({ disabled_at: before.disabled_at ? undefined : now, updated_at: now })
				.where("id", "=", id)
				.returning(USER_COLUMNS)
				.executeTakeFirstOrThrow();
			await trx.deleteFrom("sessions").where("user_id", "=", id).execute();
			await trx
				.updateTable("preview_sessions")
				.set({ revoked_at: now })
				.where("user_id", "=", id)
				.where("revoked_at", "is", null)
				.execute();
			await trx
				.updateTable("workspaces")
				.set({ desired_state: "stopped", updated_at: now })
				.where("owner_user_id", "=", id)
				.execute();
			await trx
				.insertInto("audit_events")
				.values({
					actor: `user:${actor.id}`,
					target: id,
					action: "user.disabled",
					result: "ok",
				})
				.execute();
			return row;
		});
		if (!updated) {
			return sendError(
				reply,
				400,
				"VALIDATION_FAILED",
				"At least one other enabled administrator must remain.",
			);
		}
		return loadAdminUser(updated.id);
	});

	// POST /admin/users/:id/promote -- grant administrator to an SSO account (ruling 23).
	app.post("/admin/users/:id/promote", adminOnly, async (request, reply) => {
		const actor = requireUser(request);
		const params = UuidParam.safeParse(request.params);
		if (!params.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", params.error.message);
		}
		const id = params.data.id;
		const result = await db.transaction().execute(async (trx) => {
			const granted = await grantAdministrator(trx, id);
			if (granted.ok && granted.changed) {
				await audit(trx, "user.role_changed", `user:${actor.id}`, id, "ok", {
					from: granted.from,
					to: granted.to,
					source: "admin",
					...requestMetadata(request),
				});
			}
			return granted;
		});
		if (!result.ok && result.reason === "not_found") {
			return sendError(reply, 404, "NOT_FOUND", "User not found");
		}
		if (!result.ok) {
			return sendError(
				reply,
				400,
				"VALIDATION_FAILED",
				"Only SSO accounts can be administrators.",
			);
		}
		return loadAdminUser(id);
	});

	// POST /admin/users/:id/demote -- remove a granted administrator role (ruling 23).
	app.post("/admin/users/:id/demote", adminOnly, async (request, reply) => {
		const actor = requireUser(request);
		const params = UuidParam.safeParse(request.params);
		if (!params.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", params.error.message);
		}
		const id = params.data.id;
		const result = await db.transaction().execute(async (trx) => {
			const revoked = await revokeAdministrator(trx, {
				actorId: actor.id,
				targetId: id,
			});
			// A provider administrator with a grant too keeps the role: nothing to audit.
			if (revoked.ok && revoked.from !== revoked.to) {
				await audit(trx, "user.role_changed", `user:${actor.id}`, id, "ok", {
					from: revoked.from,
					to: revoked.to,
					source: "admin",
					...requestMetadata(request),
				});
			}
			return revoked;
		});
		if (!result.ok) {
			switch (result.reason) {
				case "not_found":
					return sendError(reply, 404, "NOT_FOUND", "User not found");
				case "self":
					return sendError(
						reply,
						400,
						"VALIDATION_FAILED",
						"You cannot demote your own account.",
					);
				case "provider_administrator":
					return sendError(
						reply,
						400,
						"VALIDATION_FAILED",
						"This administrator comes from the SSO provider's groups.",
					);
				case "not_administrator":
					return sendError(
						reply,
						400,
						"VALIDATION_FAILED",
						"This account is not an administrator.",
					);
				case "last_administrator":
					return sendError(
						reply,
						400,
						"VALIDATION_FAILED",
						"At least one other enabled administrator must remain.",
					);
			}
		}
		return loadAdminUser(id);
	});

	// POST /admin/users/:id/enable -- sign-in works again; nothing else changes.
	app.post("/admin/users/:id/enable", adminOnly, async (request, reply) => {
		const actor = requireUser(request);
		const params = UuidParam.safeParse(request.params);
		if (!params.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", params.error.message);
		}
		const id = params.data.id;
		const updated = await db.transaction().execute(async (trx) => {
			const now = new Date().toISOString();
			const row = await trx
				.updateTable("users")
				.set({ disabled_at: null, updated_at: now })
				.where("id", "=", id)
				.returning(USER_COLUMNS)
				.executeTakeFirst();
			if (!row) return null;
			await trx
				.insertInto("audit_events")
				.values({
					actor: `user:${actor.id}`,
					target: id,
					action: "user.enabled",
					result: "ok",
				})
				.execute();
			return row;
		});
		if (!updated) {
			return sendError(reply, 404, "NOT_FOUND", "User not found");
		}
		return loadAdminUser(updated.id);
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
				.returning(USER_COLUMNS)
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

		return loadAdminUser(updated.id);
	});
}
