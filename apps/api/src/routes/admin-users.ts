import { dexLocalUserId } from "@portikus/auth";
import { type AdminUser, Role } from "@portikus/contracts";
import { type Database, recordAudit } from "@portikus/db";
import type { FastifyReply } from "fastify";
import { type Kysely, sql } from "kysely";
import { accountFlags, groupByEmail } from "../admin/markers.js";
import { sendError } from "../http.js";
import type { ServerDeps } from "../server.js";
import { loadImageFacts, toWorkspaceSummary } from "./admin-workspaces.js";

/** The users columns the administration pages read. */
export const USER_COLUMNS = [
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

export type AdminUserDeps = Pick<ServerDeps, "db" | "config" | "dex" | "logger">;

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
			createdAt: new Date(user.created_at),
		})),
		new Date(),
	);

	return groupByEmail(users).map((user) => {
		const workspace = byOwner.get(user.id);
		const flag = flags.get(user.id) ?? {
			duplicateEmail: false,
			stale: false,
			notSignedInYet: false,
		};
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
				? toWorkspaceSummary(workspace, active.get(workspace.id) ?? 0, facts, defaults)
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
		await recordAudit(trx, {
			actor: `user:${actorId}`,
			target: id,
			action: "user.disabled",
			result: "ok",
		});
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
