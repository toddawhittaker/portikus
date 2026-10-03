import { requireRole, requireUser } from "@portikus/auth";
import {
	type AdminEgressView,
	type ApiErrorCode,
	EGRESS_LIMITS,
	EGRESS_PRESETS,
	EgressBlockedSiteRequest,
	EgressDeleteQuery,
	EgressEntryRequest,
	type EgressMode,
	EgressModeRequest,
	EgressPortsRequest,
	EgressPresetId,
	EgressPresetsRequest,
} from "@portikus/contracts";
import { type Database, isUniqueViolation, recordAudit } from "@portikus/db";
import type { FastifyInstance, FastifyReply } from "fastify";
import { type Kysely, sql, type Transaction } from "kysely";
import type { z } from "zod";
import type { ServerDeps } from "../deps.js";
import { parseOr400, sendError, UuidParam } from "../http.js";

const adminOnly = { preHandler: requireRole("administrator") };

/** Thrown inside a write's transaction to roll it back with an answer. */
class Refusal extends Error {
	constructor(
		readonly status: number,
		readonly code: ApiErrorCode,
		message: string,
	) {
		super(message);
	}
}

async function readView(db: Kysely<Database>): Promise<AdminEgressView | null> {
	const s = await db
		.selectFrom("settings")
		.select([
			"egress_mode",
			"egress_presets",
			"egress_ports",
			"egress_version",
			"egress_applied_version",
			"egress_applied_at",
			"egress_apply_error",
		])
		.where("id", "=", 1)
		.executeTakeFirst();
	// The worker seeds the settings row on first start.
	if (!s) return null;
	const entries = await db
		.selectFrom("egress_entries")
		.selectAll()
		.orderBy("kind")
		.orderBy("value")
		.execute();
	const blockedSites = await db
		.selectFrom("egress_blocked_entries")
		.selectAll()
		.orderBy("value")
		.execute();
	const blocked = await db
		.selectFrom("egress_blocked_names")
		.select(["name", sql<number>`sum(count)::int`.as("count")])
		.where("day", ">=", sql<Date>`current_date - 6`)
		.groupBy("name")
		.orderBy("count", "desc")
		.orderBy("name")
		.limit(20)
		.execute();
	return {
		version: s.egress_version,
		mode: s.egress_mode as EgressMode,
		presets: s.egress_presets.filter(
			(p): p is EgressPresetId => EgressPresetId.safeParse(p).success,
		),
		ports: s.egress_ports,
		entries: entries.map((e) => ({
			id: e.id,
			kind: e.kind as "host" | "range",
			value: e.value,
			label: e.label,
			createdAt: e.created_at.toISOString(),
			updatedAt: e.updated_at.toISOString(),
		})),
		blockedSites: blockedSites.map((b) => ({
			id: b.id,
			value: b.value,
			label: b.label,
			createdAt: b.created_at.toISOString(),
			updatedAt: b.updated_at.toISOString(),
		})),
		presetCatalog: EGRESS_PRESETS.map((p) => ({
			id: p.id,
			label: p.label,
			hosts: [...p.hosts],
		})),
		apply: {
			appliedVersion: s.egress_applied_version,
			appliedAt: s.egress_applied_at ? s.egress_applied_at.toISOString() : null,
			error: s.egress_apply_error,
		},
		blocked,
	};
}

/**
 * Raises the policy version if the caller's is current; the stale-version
 * 409 keeps two administrators from overwriting each other.
 */
async function bumpVersion(trx: Transaction<Database>, version: number): Promise<void> {
	const row = await trx
		.updateTable("settings")
		.set({ egress_version: sql`egress_version + 1` })
		.where("id", "=", 1)
		.where("egress_version", "=", version)
		.returning("egress_version")
		.executeTakeFirst();
	if (row) return;
	const exists = await trx
		.selectFrom("settings")
		.select("id")
		.where("id", "=", 1)
		.executeTakeFirst();
	if (!exists) {
		throw new Refusal(404, "NOT_FOUND", "Platform settings are not set yet");
	}
	throw new Refusal(
		409,
		"EGRESS_VERSION_STALE",
		"The egress policy changed since it was loaded. Reload and try again.",
	);
}

async function audit(
	trx: Transaction<Database>,
	actorId: string,
	target: string,
	action: string,
	metadata: Record<string, unknown>,
): Promise<void> {
	await recordAudit(trx, {
		actor: `user:${actorId}`,
		target,
		action,
		result: "ok",
		metadata: metadata,
	});
}

async function countKind(trx: Transaction<Database>, kind: string): Promise<number> {
	const row = await trx
		.selectFrom("egress_entries")
		.select(sql<number>`count(*)::int`.as("n"))
		.where("kind", "=", kind)
		.executeTakeFirstOrThrow();
	return row.n;
}

/**
 * The workspace egress policy's admin routes (SPEC.md sections
 * 20.1, 24.9 and 24.11). The API only writes the policy and raises its
 * version; the worker applies it through the controller.
 */
export function registerAdminEgressRoutes(
	app: FastifyInstance,
	deps: ServerDeps,
): void {
	const { db } = deps;

	/** Runs one write in a transaction and answers with the fresh view. */
	async function write(
		reply: FastifyReply,
		work: (trx: Transaction<Database>) => Promise<void>,
		duplicate = "That entry is already listed",
	): Promise<unknown> {
		try {
			await db.transaction().execute(work);
		} catch (err) {
			if (err instanceof Refusal)
				return sendError(reply, err.status, err.code, err.message);
			if (isUniqueViolation(err)) {
				return sendError(reply, 409, "EGRESS_ENTRY_EXISTS", duplicate);
			}
			throw err;
		}
		return sendView(reply);
	}

	async function sendView(reply: FastifyReply): Promise<unknown> {
		const view = await readView(db);
		if (!view)
			return sendError(reply, 404, "NOT_FOUND", "Platform settings are not set yet");
		return view;
	}

	function invalid(reply: FastifyReply, error: z.ZodError) {
		return sendError(
			reply,
			400,
			"VALIDATION_FAILED",
			error.issues[0]?.message ?? "invalid request",
		);
	}

	app.get("/admin/egress", adminOnly, async (_request, reply) => sendView(reply));

	app.put("/admin/egress/mode", adminOnly, async (request, reply) => {
		const admin = requireUser(request);
		const body = EgressModeRequest.safeParse(request.body);
		if (!body.success) return invalid(reply, body.error);
		return write(reply, async (trx) => {
			await bumpVersion(trx, body.data.version);
			const before = await trx
				.selectFrom("settings")
				.select("egress_mode")
				.where("id", "=", 1)
				.executeTakeFirstOrThrow();
			await trx
				.updateTable("settings")
				.set({ egress_mode: body.data.mode })
				.where("id", "=", 1)
				.execute();
			await audit(trx, admin.id, "egress", "egress.mode_changed", {
				from: before.egress_mode,
				to: body.data.mode,
			});
		});
	});

	app.put("/admin/egress/presets", adminOnly, async (request, reply) => {
		const admin = requireUser(request);
		const body = EgressPresetsRequest.safeParse(request.body);
		if (!body.success) return invalid(reply, body.error);
		return write(reply, async (trx) => {
			await bumpVersion(trx, body.data.version);
			await trx
				.updateTable("settings")
				.set({ egress_presets: body.data.presets })
				.where("id", "=", 1)
				.execute();
			await audit(trx, admin.id, "egress", "egress.presets_changed", {
				presets: body.data.presets,
			});
		});
	});

	app.put("/admin/egress/ports", adminOnly, async (request, reply) => {
		const admin = requireUser(request);
		const body = EgressPortsRequest.safeParse(request.body);
		if (!body.success) return invalid(reply, body.error);
		const ports = [...body.data.ports].sort((a, b) => a - b);
		return write(reply, async (trx) => {
			await bumpVersion(trx, body.data.version);
			await trx
				.updateTable("settings")
				.set({ egress_ports: ports })
				.where("id", "=", 1)
				.execute();
			await audit(trx, admin.id, "egress", "egress.ports_changed", { ports });
		});
	});

	app.post("/admin/egress/entries", adminOnly, async (request, reply) => {
		const admin = requireUser(request);
		const body = EgressEntryRequest.safeParse(request.body);
		if (!body.success) return invalid(reply, body.error);
		const { kind, value, label, version } = body.data;
		return write(reply, async (trx) => {
			await bumpVersion(trx, version);
			const limit = kind === "host" ? EGRESS_LIMITS.hosts : EGRESS_LIMITS.ranges;
			if ((await countKind(trx, kind)) >= limit) {
				throw new Refusal(
					409,
					"EGRESS_LIMIT_REACHED",
					`At most ${limit} ${kind === "host" ? "host names" : "ranges"} can be listed`,
				);
			}
			const row = await trx
				.insertInto("egress_entries")
				.values({ kind, value, label, created_by: admin.id })
				.returning("id")
				.executeTakeFirstOrThrow();
			await audit(trx, admin.id, row.id, "egress.entry_added", { kind, value, label });
		});
	});

	app.put("/admin/egress/entries/:id", adminOnly, async (request, reply) => {
		const admin = requireUser(request);
		const params = parseOr400(UuidParam, request.params, reply, "invalid entry id");
		if (!params) return;
		const body = EgressEntryRequest.safeParse(request.body);
		if (!body.success) return invalid(reply, body.error);
		const { kind, value, label, version } = body.data;
		return write(reply, async (trx) => {
			await bumpVersion(trx, version);
			const before = await trx
				.selectFrom("egress_entries")
				.select(["kind", "value", "label"])
				.where("id", "=", params.id)
				.executeTakeFirst();
			if (!before) throw new Refusal(404, "NOT_FOUND", "Entry not found");
			if (
				before.kind !== kind &&
				(await countKind(trx, kind)) >=
					EGRESS_LIMITS[kind === "host" ? "hosts" : "ranges"]
			) {
				throw new Refusal(409, "EGRESS_LIMIT_REACHED", "The list is full");
			}
			await trx
				.updateTable("egress_entries")
				.set({ kind, value, label, updated_at: new Date().toISOString() })
				.where("id", "=", params.id)
				.execute();
			await audit(trx, admin.id, params.id, "egress.entry_updated", {
				from: before,
				to: { kind, value, label },
			});
		});
	});

	app.delete("/admin/egress/entries/:id", adminOnly, async (request, reply) => {
		const admin = requireUser(request);
		const params = parseOr400(UuidParam, request.params, reply, "invalid entry id");
		if (!params) return;
		const query = EgressDeleteQuery.safeParse(request.query);
		if (!query.success) return invalid(reply, query.error);
		return write(reply, async (trx) => {
			await bumpVersion(trx, query.data.version);
			const gone = await trx
				.deleteFrom("egress_entries")
				.where("id", "=", params.id)
				.returning(["kind", "value", "label"])
				.executeTakeFirst();
			if (!gone) throw new Refusal(404, "NOT_FOUND", "Entry not found");
			await audit(trx, admin.id, params.id, "egress.entry_removed", gone);
		});
	});
	// Blocked sites: refused in open mode only (ADR 0043).
	const BLOCK_EXISTS = "That site is already blocked";
	app.post("/admin/egress/blocked-sites", adminOnly, async (request, reply) => {
		const admin = requireUser(request);
		const body = EgressBlockedSiteRequest.safeParse(request.body);
		if (!body.success) return invalid(reply, body.error);
		const { value, label, version } = body.data;
		return write(
			reply,
			async (trx) => {
				await bumpVersion(trx, version);
				const row = await trx
					.selectFrom("egress_blocked_entries")
					.select(sql<number>`count(*)::int`.as("n"))
					.executeTakeFirstOrThrow();
				if (row.n >= EGRESS_LIMITS.blockedSites) {
					throw new Refusal(
						409,
						"EGRESS_LIMIT_REACHED",
						`At most ${EGRESS_LIMITS.blockedSites} sites can be blocked`,
					);
				}
				const added = await trx
					.insertInto("egress_blocked_entries")
					.values({ value, label, created_by: admin.id })
					.returning("id")
					.executeTakeFirstOrThrow();
				await audit(trx, admin.id, added.id, "egress.block_added", { value, label });
			},
			BLOCK_EXISTS,
		);
	});

	app.put("/admin/egress/blocked-sites/:id", adminOnly, async (request, reply) => {
		const admin = requireUser(request);
		const params = parseOr400(UuidParam, request.params, reply, "invalid entry id");
		if (!params) return;
		const body = EgressBlockedSiteRequest.safeParse(request.body);
		if (!body.success) return invalid(reply, body.error);
		const { value, label, version } = body.data;
		return write(
			reply,
			async (trx) => {
				await bumpVersion(trx, version);
				const before = await trx
					.selectFrom("egress_blocked_entries")
					.select(["value", "label"])
					.where("id", "=", params.id)
					.executeTakeFirst();
				if (!before) throw new Refusal(404, "NOT_FOUND", "Blocked site not found");
				await trx
					.updateTable("egress_blocked_entries")
					.set({ value, label, updated_at: new Date().toISOString() })
					.where("id", "=", params.id)
					.execute();
				await audit(trx, admin.id, params.id, "egress.block_updated", {
					from: before,
					to: { value, label },
				});
			},
			BLOCK_EXISTS,
		);
	});

	// jscpd:ignore-start -- each route spells out its own checks, in order.
	app.delete("/admin/egress/blocked-sites/:id", adminOnly, async (request, reply) => {
		const admin = requireUser(request);
		const params = parseOr400(UuidParam, request.params, reply, "invalid entry id");
		if (!params) return;
		const query = EgressDeleteQuery.safeParse(request.query);
		if (!query.success) return invalid(reply, query.error);
		return write(reply, async (trx) => {
			await bumpVersion(trx, query.data.version);
			const gone = await trx
				.deleteFrom("egress_blocked_entries")
				.where("id", "=", params.id)
				.returning(["value", "label"])
				.executeTakeFirst();
			if (!gone) throw new Refusal(404, "NOT_FOUND", "Blocked site not found");
			await audit(trx, admin.id, params.id, "egress.block_removed", gone);
		});
	});
	// jscpd:ignore-end
}
