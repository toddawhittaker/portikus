import {
	grantAdministrator,
	grantInstructor,
	type RoleChange,
	requireRole,
	requireUser,
	revokeAdministrator,
	revokeInstructor,
} from "@portikus/auth";
import {
	type AdminUserList,
	AdminUsersQuery,
	type AdminWorkspaceList,
	DEFAULT_ACCEPTABLE_USE_TEXT,
	LogLevel,
	type PlatformSettings,
	UpdateAdminUserSettingsRequest,
	UpdatePlatformSettingsRequest,
} from "@portikus/contracts";
import { type Database, recordAudit } from "@portikus/db";
import type { FastifyInstance } from "fastify";
import type { Kysely, Updateable } from "kysely";
import { refuseInstallAdminChange } from "../admin/install-admin.js";
import {
	disableUser,
	listAdminUsers,
	loadAdminUser,
	sendDisableRefusal,
	USER_COLUMNS,
} from "../admin/users.js";
import { queryAdminUsers } from "../admin/users-query.js";
import type { ServerDeps } from "../deps.js";
import { parseOr400, sendError, UuidParam } from "../http.js";
import { requestMetadata } from "../sessions/start-session.js";
import { workspaceViews } from "../workspaces/workspace-view.js";

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
	"cpu_throttle_hold_after",
	"cpu_throttle_hold_hours",
	"idle_stop_minutes",
	"keep_running_max_hours",
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
	cpu_throttle_hold_after: number;
	cpu_throttle_hold_hours: number;
	idle_stop_minutes: number;
	keep_running_max_hours: number;
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
		cpuThrottleHoldAfter: row.cpu_throttle_hold_after,
		cpuThrottleHoldHours: row.cpu_throttle_hold_hours,
		idleStopMinutes: row.idle_stop_minutes,
		keepRunningMaxHours: row.keep_running_max_hours,
		acceptableUseText: row.acceptable_use_text,
		acceptableUseVersion: row.acceptable_use_version,
		updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
	};
}

const adminOnly = { preHandler: requireRole("administrator") };

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

		const workspaces = await workspaceViews(db, config, rows);

		const body: AdminWorkspaceList = { workspaces };
		return body;
	});

	// The platform-wide grace period.
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

	// The worker picks up a change at its next sweep.
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

		// The guard numbers, idle lift and throttle hold included, share one audit row with only the keys whose value changed.
		const guardFields = [
			["cpuGuardThresholdPercent", "cpu_guard_threshold_percent"],
			["memoryGuardThresholdPercent", "memory_guard_threshold_percent"],
			["guardWindowMinutes", "guard_window_minutes"],
			["cpuThrottleSharePercent", "cpu_throttle_share_percent"],
			["cpuIdleLiftMinutes", "cpu_idle_lift_minutes"],
			["cpuIdleLiftPercent", "cpu_idle_lift_percent"],
			["cpuThrottleHoldAfter", "cpu_throttle_hold_after"],
			["cpuThrottleHoldHours", "cpu_throttle_hold_hours"],
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
		if (
			body.data.keepRunningMaxHours !== undefined &&
			body.data.keepRunningMaxHours !== before.keep_running_max_hours
		) {
			changes.keep_running_max_hours = body.data.keepRunningMaxHours;
			audits.push({
				action: "settings.keep_running_updated",
				details: {
					from: before.keep_running_max_hours,
					to: body.data.keepRunningMaxHours,
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
				await recordAudit(trx, {
					actor: `user:${user.id}`,
					target: "settings",
					action: audit.action,
					result: "ok",
					metadata: {
						...audit.details,
						ip: request.ip,
						userAgent: request.headers["user-agent"] ?? null,
					},
				});
			}
			return row;
		});

		return toPlatformSettings(updated);
	});

	app.get("/admin/users", adminOnly, async (request, reply) => {
		const query = AdminUsersQuery.safeParse(request.query);
		if (!query.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", "invalid users query");
		}
		// Markers are computed over every account; only then does a page cut the list.
		const page = queryAdminUsers(await listAdminUsers(deps), query.data);
		const body: AdminUserList = { ...page, dexUsers: deps.dex !== undefined };
		return body;
	});

	// The one platform-side revocation (SPEC.md §20.1).
	app.post("/admin/users/:id/disable", adminOnly, async (request, reply) => {
		const actor = requireUser(request);
		const params = parseOr400(UuidParam, request.params, reply);
		if (!params) return;
		const refused = await refuseInstallAdminChange(db, config.OIDC_ISSUER_URL, {
			request,
			reply,
			actorId: actor.id,
			targetId: params.id,
			action: "user.disabled",
		});
		if (refused) return reply;
		const result = await disableUser(db, {
			actorId: actor.id,
			targetId: params.id,
			metadata: requestMetadata(request),
		});
		if (!result.ok) return sendDisableRefusal(reply, result.reason);
		return loadUser(params.id);
	});

	/**
	 * One role route: run the grant or revoke in a transaction, audit
	 * `user.role_changed` only when the role actually changed, and answer a
	 * refusal with its message.
	 */
	function roleRoute<R extends string>(
		path: string,
		change: (
			trx: Kysely<Database>,
			actorId: string,
			targetId: string,
		) => Promise<({ ok: true } & RoleChange) | { ok: false; reason: R | "not_found" }>,
		refusals: Record<R, string>,
	): void {
		app.post(path, adminOnly, async (request, reply) => {
			const actor = requireUser(request);
			const params = parseOr400(UuidParam, request.params, reply);
			if (!params) return;
			const id = params.id;
			const refused = await refuseInstallAdminChange(db, config.OIDC_ISSUER_URL, {
				request,
				reply,
				actorId: actor.id,
				targetId: id,
				action: "user.role_changed",
			});
			if (refused) return reply;
			const result = await db.transaction().execute(async (trx) => {
				const changed = await change(trx, actor.id, id);
				if (changed.ok && changed.from !== changed.to) {
					await recordAudit(trx, {
						actor: `user:${actor.id}`,
						target: id,
						action: "user.role_changed",
						result: "ok",
						metadata: {
							from: changed.from,
							to: changed.to,
							source: "admin",
							...requestMetadata(request),
						},
					});
				}
				return changed;
			});
			if (!result.ok) {
				if (result.reason === "not_found") {
					return sendError(reply, 404, "NOT_FOUND", "User not found");
				}
				return sendError(reply, 400, "VALIDATION_FAILED", refusals[result.reason]);
			}
			return loadUser(id);
		});
	}

	roleRoute(
		"/admin/users/:id/promote",
		(trx, _actorId, targetId) => grantAdministrator(trx, targetId),
		{ course_account: "Only SSO accounts can be administrators." },
	);

	roleRoute(
		"/admin/users/:id/demote",
		(trx, actorId, targetId) => revokeAdministrator(trx, { actorId, targetId }),
		{
			self: "You cannot demote your own account.",
			provider_administrator:
				"This administrator comes from the SSO provider's groups.",
			not_administrator: "This account is not an administrator.",
			last_administrator: "At least one other enabled administrator must remain.",
		},
	);

	roleRoute(
		"/admin/users/:id/make-instructor",
		(trx, _actorId, targetId) => grantInstructor(trx, targetId),
		{
			course_account: "Only SSO accounts can be instructors.",
			granted_administrator: "Demote first.",
		},
	);

	roleRoute(
		"/admin/users/:id/remove-instructor",
		(trx, _actorId, targetId) => revokeInstructor(trx, targetId),
		{ not_granted: "This account has no instructor grant." },
	);

	// Sign-in works again; nothing else changes.
	app.post("/admin/users/:id/enable", adminOnly, async (request, reply) => {
		const actor = requireUser(request);
		const params = parseOr400(UuidParam, request.params, reply);
		if (!params) return;
		const id = params.id;
		const updated = await db.transaction().execute(async (trx) => {
			const now = new Date().toISOString();
			const row = await trx
				.updateTable("users")
				.set({ disabled_at: null, updated_at: now })
				.where("id", "=", id)
				.returning(USER_COLUMNS)
				.executeTakeFirst();
			if (!row) return null;
			await recordAudit(trx, {
				actor: `user:${actor.id}`,
				target: id,
				action: "user.enabled",
				result: "ok",
				metadata: requestMetadata(request),
			});
			return row;
		});
		if (!updated) {
			return sendError(reply, 404, "NOT_FOUND", "User not found");
		}
		return loadUser(updated.id);
	});

	// Set or clear one user's override.
	app.put("/admin/users/:id/settings", adminOnly, async (request, reply) => {
		const actor = requireUser(request);

		const params = parseOr400(UuidParam, request.params, reply);
		if (!params) return;

		const body = UpdateAdminUserSettingsRequest.safeParse(request.body ?? {});
		if (!body.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", body.error.message);
		}

		const before = await db
			.selectFrom("users")
			.select("shutdown_grace_seconds")
			.where("id", "=", params.id)
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
				.where("id", "=", params.id)
				.returning(USER_COLUMNS)
				.executeTakeFirstOrThrow();
			await recordAudit(trx, {
				actor: `user:${actor.id}`,
				target: params.id,
				action: "user.shutdown_grace_updated",
				result: "ok",
				metadata: {
					from: before.shutdown_grace_seconds,
					to: body.data.shutdownGraceSeconds,
					ip: request.ip,
					userAgent: request.headers["user-agent"] ?? null,
				},
			});
			return row;
		});

		return loadUser(updated.id);
	});
}
