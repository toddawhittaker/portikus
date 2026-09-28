import { requireRole } from "@portikus/auth";
import {
	ADMIN_PACKAGES_LIMIT,
	type AdminPackagesResponse,
	isBaseImageCandidate,
	PACKAGE_SURVEY_MIN_SURVEYED,
} from "@portikus/contracts";
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import type { ServerDeps } from "../server.js";

const adminOnly = { preHandler: requireRole("administrator") };
const today = sql<Date>`(now() at time zone 'utc')::date`;

/**
 * The package survey's site-wide counts (SPEC.md §20.1, ADR 0042). Only
 * days that surveyed at least PACKAGE_SURVEY_MIN_SURVEYED workspaces count,
 * so a count cannot single out one student, and only completed UTC days
 * (before today), so watching today's count grow cannot single one out
 * either. Every package seen on those
 * days is listed with the latest such day's count, so a package nobody has
 * any more shows 0 with the day it was last seen.
 */
export function registerAdminPackageRoutes(
	app: FastifyInstance,
	deps: ServerDeps,
): void {
	const { db } = deps;

	app.get("/admin/packages", adminOnly, async (): Promise<AdminPackagesResponse> => {
		const latestOf = (minimum: number) =>
			db
				.selectFrom("package_survey_days")
				.select([sql<string>`to_char(day, 'YYYY-MM-DD')`.as("day"), "surveyed"])
				.where("surveyed", ">=", minimum)
				.where("day", "<", today)
				.orderBy("day", "desc")
				.limit(1)
				.executeTakeFirst();
		const latest = await latestOf(PACKAGE_SURVEY_MIN_SURVEYED);
		if (!latest) {
			const any = await latestOf(0);
			return {
				day: any?.day ?? null,
				surveyed: any?.surveyed ?? 0,
				packages: [],
			};
		}

		const rows = await db
			.selectFrom("package_survey_counts")
			.where(({ exists, selectFrom }) =>
				exists(
					selectFrom("package_survey_days as d")
						.select(sql`1`.as("one"))
						.whereRef("d.day", "=", "package_survey_counts.day")
						.where("d.surveyed", ">=", PACKAGE_SURVEY_MIN_SURVEYED)
						.where("d.day", "<", today),
				),
			)
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
