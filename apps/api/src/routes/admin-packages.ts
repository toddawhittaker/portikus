import { requireRole } from "@portikus/auth";
import {
	ADMIN_PACKAGES_LIMIT,
	type AdminPackagesResponse,
	isBaseImageCandidate,
} from "@portikus/contracts";
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import type { ServerDeps } from "../server.js";

const adminOnly = { preHandler: requireRole("administrator") };

/**
 * The package survey's site-wide counts (SPEC.md §20.1, ADR 0042). Every
 * package seen in the kept days is listed with the latest day's count, so a
 * package nobody has any more shows 0 with the day it was last seen. The
 * tables hold counts only, so nothing here can name a workspace.
 */
export function registerAdminPackageRoutes(
	app: FastifyInstance,
	deps: ServerDeps,
): void {
	const { db } = deps;

	app.get("/admin/packages", adminOnly, async (): Promise<AdminPackagesResponse> => {
		const latest = await db
			.selectFrom("package_survey_days")
			.select([sql<string>`to_char(day, 'YYYY-MM-DD')`.as("day"), "surveyed"])
			.orderBy("day", "desc")
			.limit(1)
			.executeTakeFirst();
		if (!latest) return { day: null, surveyed: 0, packages: [] };

		const rows = await db
			.selectFrom("package_survey_counts")
			.select([
				"package",
				sql<number>`coalesce(sum(workspaces) filter (where day = ${latest.day}::date), 0)::int`.as(
					"workspaces",
				),
				sql<string>`to_char(min(day), 'YYYY-MM-DD')`.as("firstSeen"),
				sql<string>`to_char(max(day), 'YYYY-MM-DD')`.as("lastSeen"),
			])
			.groupBy("package")
			.orderBy(sql`2`, "desc")
			.orderBy(sql`max(day)`, "desc")
			.orderBy("package")
			.limit(ADMIN_PACKAGES_LIMIT)
			.execute();

		return {
			day: latest.day,
			surveyed: latest.surveyed,
			packages: rows.map((row) => ({
				package: row.package,
				workspaces: row.workspaces,
				firstSeen: row.firstSeen,
				lastSeen: row.lastSeen,
				candidate: isBaseImageCandidate(row.workspaces, latest.surveyed),
			})),
		};
	});
}
