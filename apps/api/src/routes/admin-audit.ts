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

const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

// Cast only text that holds a UUID, so a target such as "settings" never fails
// the cast, and the joins look names up by primary key.
const actorUuid = sql`case when a.actor ~* ${`^user:${UUID_PATTERN}$`} then substr(a.actor, 6)::uuid end`;
const targetUuid = sql`case when a.target ~* ${`^${UUID_PATTERN}$`} then a.target::uuid end`;

/**
 * `GET /admin/audit` (SPEC.md §24.11, §26): newest first, keyset paged by id.
 * Audit rows name workspaces and users by bare id as the target, and users
 * as `user:<id>` when they are the actor. Each page resolves both to display
 * names, a workspace target to its owner's name.
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
				.leftJoin("users as u", (join) => join.on(sql`u.id`, "=", actorUuid))
				.leftJoin("users as tu", (join) => join.on(sql`tu.id`, "=", targetUuid))
				.leftJoin("workspaces as tw", (join) => join.on(sql`tw.id`, "=", targetUuid))
				.leftJoin("users as owner", "owner.id", "tw.owner_user_id")
				.select([
					"a.id",
					"a.at",
					"a.actor",
					"a.action",
					"a.target",
					"a.result",
					"a.metadata",
					"u.display_name as actor_name",
					sql<string | null>`coalesce(tu.display_name, owner.display_name)`.as(
						"target_name",
					),
				])
				.orderBy("a.id", "desc")
				// One extra row says whether another page follows.
				.limit(AUDIT_PAGE_SIZE + 1);
			if (query.workspace) select = select.where("a.target", "=", query.workspace);
			if (query.user) {
				const user = query.user;
				select = select.where((eb) =>
					eb.or([
						eb("a.target", "=", user),
						eb("a.actor", "=", `user:${user}`),
						eb(
							"a.target",
							"in",
							eb
								.selectFrom("workspaces")
								.select(sql<string>`id::text`.as("id"))
								.where("owner_user_id", "=", user),
						),
					]),
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
				targetName: row.target_name ?? null,
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
