import {
	dexLocalUserId,
	grantAdministrator,
	grantInstructor,
	requireRole,
	requireUser,
	revokeAdministrator,
	revokeInstructor,
} from "@portikus/auth";
import {
	type AdminUser,
	type AdminUserList,
	type AdminWorkspaceList,
	type ApiError,
	DEFAULT_ACCEPTABLE_USE_TEXT,
	LogLevel,
	type PlatformSettings,
	Role,
	UpdateAdminUserSettingsRequest,
	UpdatePlatformSettingsRequest,
} from "@portikus/contracts";
import type { Database } from "@portikus/db";
import type { FastifyInstance, FastifyReply } from "fastify";
import { type Kysely, sql, type Updateable } from "kysely";
import { z } from "zod";
import { accountFlags, groupByEmail } from "../admin/markers.js";
import type { ServerDeps } from "../server.js";
import { loadImageFacts, toWorkspaceSummary } from "./admin-workspaces.js";
import { audit, requestMetadata } from "./start-session.js";
import { countActive, toWorkspace } from "./workspace-view.js";

export const UuidParam = z.object({ id: z.string().uuid() });

/** The settings columns this route may write. */
type SettingsUpdate = Partial<Updateable<Database["settings"]>>;

/** The stored level, or null when it is unset or no longer a level we know. */
function toLogLevel(value: string | null): LogLevel | null {
	if (value === null) return null;
	const parsed = LogLevel.safeParse(value);
	return parsed.success ? parsed.data : null;
}

/** The settings columns `GET` and `PUT /admin/settings` answer with. */
const SETTINGS_COLUMNS = [
	"shutdown_grace_seconds",
	"log_level",
	"cpu_guard_threshold_percent",
	"memory_guard_threshold_percent",
	"guard_window_minutes",
	"cpu_throttle_share_percent",
	"cpu_idle_lift_minutes",
	"cpu_idle_lift_percent",
	"idle_stop_minutes",
	"acceptable_use_text",
	"acceptable_use_version",
	"updated_at",
] as const;

function toPlatformSettings(row: {
	shutdown_grace_seconds: number;
	log_level: string | null;
	cpu_guard_threshold_percent: number;
	memory_guard_threshold_percent: number;
	guard_window_minutes: number;
	cpu_throttle_share_percent: number;
	cpu_idle_lift_minutes: number;
	cpu_idle_lift_percent: number;
	idle_stop_minutes: number;
	acceptable_use_text: string | null;
	acceptable_use_version: number;
	updated_at: Date | null;
}): PlatformSettings {
	return {
		shutdownGraceSeconds: row.shutdown_grace_seconds,
		logLevel: toLogLevel(row.log_level),
		cpuGuardThresholdPercent: row.cpu_guard_threshold_percent,
		memoryGuardThresholdPercent: row.memory_guard_threshold_percent,
		guardWindowMinutes: row.guard_window_minutes,
		cpuThrottleSharePercent: row.cpu_throttle_share_percent,
		cpuIdleLiftMinutes: row.cpu_idle_lift_minutes,
		cpuIdleLiftPercent: row.cpu_idle_lift_percent,
		idleStopMinutes: row.idle_stop_minutes,
		acceptableUseText: row.acceptable_use_text,
		acceptableUseVersion: row.acceptable_use_version,
		updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
	};
}

const adminOnly = { preHandler: requireRole("administrator") };

export function sendError(
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
}): Omit<AdminUser, "markers" | "workspace" | "dexLocal"> {
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

type AdminUserDeps = Pick<ServerDeps, "db" | "config" | "dex" | "logger">;

/**
 * The user IDs of Dex's local passwords: an empty set when the site has no
 * Dex API, and "unknown" when Dex does not answer, so the list still loads.
 */
async function listDexUserIds(
	dex: ServerDeps["dex"],
	logger: ServerDeps["logger"],
): Promise<Set<string> | "unknown"> {
	if (!dex) return new Set();
	try {
		return new Set((await dex.listPasswords()).map((password) => password.userId));
	} catch {
		logger.warn("dex did not answer the password list");
		return "unknown";
	}
}

/**
 * A local Dex password this site manages (docs/archive/epics/EPIC-14.md ruling 24). Under
 * Dex in front of an upstream provider, only the local (guest) accounts. While
 * Dex does not answer, the subject alone decides, so a click reports the outage.
 */
function isDexLocal(
	user: { oidc_issuer: string; oidc_subject: string },
	dexIssuer: string,
	dexUserIds: Set<string> | "unknown",
): boolean {
	if (user.oidc_issuer !== dexIssuer) return false;
	const userId = dexLocalUserId(user.oidc_subject);
	if (userId === null) return false;
	return dexUserIds === "unknown" || dexUserIds.has(userId);
}

/** Every account with its markers and workspace (issue #302). */
export async function listAdminUsers({
	db,
	config,
	dex,
	logger,
}: AdminUserDeps): Promise<AdminUser[]> {
	const users = await db
		.selectFrom("users")
		.select([...USER_COLUMNS, "oidc_subject", "created_at"])
		.orderBy("display_name")
		.orderBy("id")
		.execute();
	const dexUserIds = await listDexUserIds(dex, logger);
	const workspaces = await db.selectFrom("workspaces").selectAll().execute();
	const links = await db.selectFrom("account_links").select("course_user_id").execute();
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
			dexLocal: isDexLocal(user, config.OIDC_ISSUER_URL, dexUserIds),
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
export async function loadAdminUser(
	deps: AdminUserDeps,
	id: string,
): Promise<AdminUser | null> {
	return (await listAdminUsers(deps)).find((user) => user.id === id) ?? null;
}

export type DisableRefusal = "self" | "not_found" | "last_administrator";

/**
 * Disable an account: end its sessions and preview sessions, stop its
 * workspace, and audit `user.disabled` (SPEC.md §20.1). `alsoInTransaction`
 * runs last, inside the same transaction, so its failure undoes the rest.
 */
export async function disableUser(
	db: Kysely<Database>,
	input: {
		actorId: string;
		targetId: string;
		alsoInTransaction?: (trx: Kysely<Database>) => Promise<void>;
	},
): Promise<{ ok: true } | { ok: false; reason: DisableRefusal }> {
	const { actorId, targetId: id } = input;
	if (id === actorId) return { ok: false, reason: "self" };
	const before = await db
		.selectFrom("users")
		.select("disabled_at")
		.where("id", "=", id)
		.executeTakeFirst();
	if (!before) return { ok: false, reason: "not_found" };

	// Every effect and its audit row commit together (SPEC.md §24.11).
	return db.transaction().execute(async (trx) => {
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
			return { ok: false, reason: "last_administrator" } as const;
		}
		const now = new Date().toISOString();
		await trx
			.updateTable("users")
			.set({ disabled_at: before.disabled_at ? undefined : now, updated_at: now })
			.where("id", "=", id)
			.execute();
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
				actor: `user:${actorId}`,
				target: id,
				action: "user.disabled",
				result: "ok",
			})
			.execute();
		await input.alsoInTransaction?.(trx);
		return { ok: true } as const;
	});
}

/** The answer to a refused disable, shared by Disable and Remove. */
export function sendDisableRefusal(reply: FastifyReply, reason: DisableRefusal): void {
	switch (reason) {
		case "not_found":
			sendError(reply, 404, "NOT_FOUND", "User not found");
			return;
		case "self":
			sendError(
				reply,
				400,
				"VALIDATION_FAILED",
				"You cannot disable your own account.",
			);
			return;
		case "last_administrator":
			sendError(
				reply,
				400,
				"VALIDATION_FAILED",
				"At least one other enabled administrator must remain.",
			);
			return;
	}
}

/** Administrator-only views and settings (SPEC.md §5.2, §6.4). */
export function registerAdminRoutes(app: FastifyInstance, deps: ServerDeps): void {
	const { db, config } = deps;
	const loadUser = (id: string) => loadAdminUser(deps, id);
	app.get("/admin/workspaces", adminOnly, async () => {
		const rows = await db
			.selectFrom("workspaces")
			.selectAll()
			.orderBy("created_at")
			.execute();

		const workspaces = await Promise.all(
			rows.map(
				async (row) =>
					await toWorkspace(
						db,
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
			.select(SETTINGS_COLUMNS)
			.where("id", "=", 1)
			.executeTakeFirst();
		if (!row) {
			return sendError(reply, 404, "NOT_FOUND", "Platform settings are not set yet");
		}
		return toPlatformSettings(row);
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
			.select(SETTINGS_COLUMNS)
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
		const audits: { action: string; details: Record<string, unknown> }[] = [];
		if (body.data.shutdownGraceSeconds !== undefined) {
			changes.shutdown_grace_seconds = body.data.shutdownGraceSeconds;
			audits.push({
				action: "settings.shutdown_grace_updated",
				details: {
					from: before.shutdown_grace_seconds,
					to: body.data.shutdownGraceSeconds,
				},
			});
		}
		if (body.data.logLevel !== undefined) {
			changes.log_level = body.data.logLevel;
			audits.push({
				action: "settings.log_level_updated",
				details: {
					from: toLogLevel(before.log_level),
					to: body.data.logLevel,
				},
			});
		}

		// The guard numbers, idle lift included, share one audit row with only the keys whose value changed.
		const guardFields = [
			["cpuGuardThresholdPercent", "cpu_guard_threshold_percent"],
			["memoryGuardThresholdPercent", "memory_guard_threshold_percent"],
			["guardWindowMinutes", "guard_window_minutes"],
			["cpuThrottleSharePercent", "cpu_throttle_share_percent"],
			["cpuIdleLiftMinutes", "cpu_idle_lift_minutes"],
			["cpuIdleLiftPercent", "cpu_idle_lift_percent"],
		] as const;
		const guardFrom: Record<string, number> = {};
		const guardTo: Record<string, number> = {};
		for (const [field, column] of guardFields) {
			const value = body.data[field];
			if (value === undefined || value === before[column]) continue;
			changes[column] = value;
			guardFrom[field] = before[column];
			guardTo[field] = value;
		}
		if (Object.keys(guardTo).length > 0) {
			audits.push({
				action: "settings.resource_guard_updated",
				details: {
					from: guardFrom,
					to: guardTo,
				},
			});
		}
		if (
			body.data.idleStopMinutes !== undefined &&
			body.data.idleStopMinutes !== before.idle_stop_minutes
		) {
			changes.idle_stop_minutes = body.data.idleStopMinutes;
			audits.push({
				action: "settings.idle_stop_updated",
				details: {
					from: before.idle_stop_minutes,
					to: body.data.idleStopMinutes,
				},
			});
		}
		if (body.data.acceptableUseText !== undefined) {
			changes.acceptable_use_text = body.data.acceptableUseText;
			// Any change to the text everyone sees asks everyone to accept again;
			// the audit row holds versions, never the text.
			const oldText = before.acceptable_use_text ?? DEFAULT_ACCEPTABLE_USE_TEXT;
			const newText = body.data.acceptableUseText ?? DEFAULT_ACCEPTABLE_USE_TEXT;
			if (oldText !== newText) {
				changes.acceptable_use_version = before.acceptable_use_version + 1;
				audits.push({
					action: "settings.acceptable_use_updated",
					details: {
						fromVersion: before.acceptable_use_version,
						toVersion: before.acceptable_use_version + 1,
					},
				});
			}
		}

		// The change and its audit rows commit together (SPEC.md §24.11).
		const updated = await db.transaction().execute(async (trx) => {
			const row = await trx
				.updateTable("settings")
				.set(changes)
				.where("id", "=", 1)
				.returning(SETTINGS_COLUMNS)
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
							...audit.details,
							ip: request.ip,
							userAgent: request.headers["user-agent"] ?? null,
						}),
					})
					.execute();
			}
			return row;
		});

		return toPlatformSettings(updated);
	});

	// GET /admin/users -- every account with its markers and workspace (issue #302).
	app.get("/admin/users", adminOnly, async () => {
		const list = await listAdminUsers(deps);
		const body: AdminUserList = { users: list, dexUsers: deps.dex !== undefined };
		return body;
	});

	// POST /admin/users/:id/disable -- the one platform-side revocation (SPEC.md §20.1).
	app.post("/admin/users/:id/disable", adminOnly, async (request, reply) => {
		const actor = requireUser(request);
		const params = UuidParam.safeParse(request.params);
		if (!params.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", params.error.message);
		}
		const result = await disableUser(db, {
			actorId: actor.id,
			targetId: params.data.id,
		});
		if (!result.ok) return sendDisableRefusal(reply, result.reason);
		return loadUser(params.data.id);
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
		return loadUser(id);
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
		return loadUser(id);
	});

	// POST /admin/users/:id/make-instructor -- grant instructor (docs/archive/epics/EPIC-14.md ruling 14).
	app.post("/admin/users/:id/make-instructor", adminOnly, async (request, reply) => {
		const actor = requireUser(request);
		const params = UuidParam.safeParse(request.params);
		if (!params.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", params.error.message);
		}
		const id = params.data.id;
		const result = await db.transaction().execute(async (trx) => {
			const granted = await grantInstructor(trx, id);
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
		if (!result.ok) {
			switch (result.reason) {
				case "not_found":
					return sendError(reply, 404, "NOT_FOUND", "User not found");
				case "course_account":
					return sendError(
						reply,
						400,
						"VALIDATION_FAILED",
						"Only SSO accounts can be instructors.",
					);
				case "granted_administrator":
					return sendError(reply, 400, "VALIDATION_FAILED", "Demote first.");
			}
		}
		return loadUser(id);
	});

	// POST /admin/users/:id/remove-instructor -- remove the instructor grant (ruling 14).
	app.post("/admin/users/:id/remove-instructor", adminOnly, async (request, reply) => {
		const actor = requireUser(request);
		const params = UuidParam.safeParse(request.params);
		if (!params.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", params.error.message);
		}
		const id = params.data.id;
		const result = await db.transaction().execute(async (trx) => {
			const revoked = await revokeInstructor(trx, id);
			// A provider instructor with the grant too keeps the role: nothing to audit.
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
		if (!result.ok && result.reason === "not_found") {
			return sendError(reply, 404, "NOT_FOUND", "User not found");
		}
		if (!result.ok) {
			return sendError(
				reply,
				400,
				"VALIDATION_FAILED",
				"This account has no instructor grant.",
			);
		}
		return loadUser(id);
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
		return loadUser(updated.id);
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

		return loadUser(updated.id);
	});
}
