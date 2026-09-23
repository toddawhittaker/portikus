import { requireRole } from "@portikus/auth";
import {
	AUDIT_PAGE_SIZE,
	type AuditEvent,
	type AuditPage,
	AuditQuery,
} from "@portikus/contracts";
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import type { ServerDeps } from "../server.js";

/**
 * `GET /admin/audit` (SPEC.md §24.11, §26): newest first, keyset paged by id.
 * Audit rows name workspaces and users by bare id as the target, and users
 * as `user:<id>` when they are the actor.
 */
export function registerAdminAuditRoutes(
	app: FastifyInstance,
	{ db }: ServerDeps,
): void {
	app.get(
		"/admin/audit",
		{ preHandler: requireRole("administrator") },
		async (request, reply) => {
			const parsed = AuditQuery.safeParse(request.query);
			if (!parsed.success) {
				return reply
					.status(400)
					.send({ code: "VALIDATION_FAILED", message: "invalid audit query" });
			}
			const query = parsed.data;

			let select = db
				.selectFrom("audit_events as a")
				.leftJoin("users as u", (join) =>
					join.on(sql`a.actor`, "=", sql`'user:' || u.id::text`),
				)
				.select([
					"a.id",
					"a.at",
					"a.actor",
					"a.action",
					"a.target",
					"a.result",
					"a.metadata",
					"u.display_name as actor_name",
				])
				.orderBy("a.id", "desc")
				// One extra row says whether another page follows.
				.limit(AUDIT_PAGE_SIZE + 1);
			if (query.workspace) select = select.where("a.target", "=", query.workspace);
			if (query.user) {
				const user = query.user;
				select = select.where((eb) =>
					eb.or([eb("a.target", "=", user), eb("a.actor", "=", `user:${user}`)]),
				);
			}
			if (query.action) {
				select = select.where(sql<boolean>`starts_with(a.action, ${query.action})`);
			}
			if (query.before) select = select.where("a.id", "<", query.before);

			const rows = await select.execute();
			const page = rows.slice(0, AUDIT_PAGE_SIZE);
			const events: AuditEvent[] = page.map((row) => ({
				id: Number(row.id),
				at: new Date(row.at).toISOString(),
				actor: row.actor,
				actorName: row.actor_name ?? null,
				action: row.action,
				target: row.target,
				result: row.result,
				metadata: row.metadata,
			}));
			const last = events.at(-1);
			const body: AuditPage = {
				events,
				nextBefore: rows.length > AUDIT_PAGE_SIZE && last ? last.id : null,
			};
			return reply.header("cache-control", "no-store").send(body);
		},
	);
}
