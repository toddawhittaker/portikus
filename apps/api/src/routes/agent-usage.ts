import { requireRole, requireUser } from "@portikus/auth";
import {
	AgentUsageQuery,
	type AgentUsageResponse,
	type AgentUsageWindow,
	CodingAgent,
} from "@portikus/contracts";
import type { Database } from "@portikus/db";
import type { FastifyInstance } from "fastify";
import { type Kysely, sql } from "kysely";
import { z } from "zod";
import { teachesCourse } from "../courses/membership.js";
import type { ServerDeps } from "../deps.js";
import { sendError } from "../http.js";

const CourseParam = z.object({ courseId: z.string().uuid() });

const DAY_MS = 86_400_000;

/** The window's first and last UTC day, inclusive, ending today. */
function windowDays(days: AgentUsageWindow, now: Date): { from: string; to: string } {
	const to = now.toISOString().slice(0, 10);
	const from = new Date(now.getTime() - (days - 1) * DAY_MS).toISOString().slice(0, 10);
	return { from, to };
}

const total = (col: string) => sql<string>`sum(${sql.ref(col)})::text`;

/** Sums over boot ids and models; cost stays null when every row is null. */
async function usageFor(
	db: Kysely<Database>,
	days: AgentUsageWindow,
	userIds: string[] | null,
	now: Date,
): Promise<AgentUsageResponse> {
	const { from, to } = windowDays(days, now);
	const base = () => {
		let q = db
			.selectFrom("agent_usage_days as u")
			.where(sql<boolean>`u.day >= ${from}::date and u.day <= ${to}::date`);
		if (userIds) q = q.where("u.user_id", "in", userIds);
		return q;
	};
	const sumColumns = [
		total("u.sessions").as("sessions"),
		total("u.input_tokens").as("input_tokens"),
		total("u.output_tokens").as("output_tokens"),
		total("u.cache_read_tokens").as("cache_read_tokens"),
		total("u.cache_write_tokens").as("cache_write_tokens"),
		sql<string | null>`sum(u.cost_usd)::text`.as("cost_usd"),
		total("u.lines_added").as("lines_added"),
		total("u.lines_removed").as("lines_removed"),
	] as const;

	// An empty member list would make `in ()` invalid SQL.
	if (userIds && userIds.length === 0) return { days, from, to, users: [], daily: [] };

	const userRows = await base()
		.innerJoin("users", "users.id", "u.user_id")
		.select(["u.user_id", "users.display_name", "u.agent", ...sumColumns])
		.groupBy(["u.user_id", "users.display_name", "u.agent"])
		.orderBy("users.display_name")
		.orderBy("u.user_id")
		.orderBy("u.agent")
		.execute();

	const dayRows = await base()
		.select([
			sql<string>`to_char(u.day, 'YYYY-MM-DD')`.as("day"),
			"u.agent",
			...sumColumns,
		])
		.groupBy(["u.day", "u.agent"])
		.orderBy("u.day")
		.orderBy("u.agent")
		.execute();

	const counts = (r: (typeof dayRows)[number]) => ({
		sessions: Number(r.sessions),
		inputTokens: Number(r.input_tokens),
		outputTokens: Number(r.output_tokens),
		cacheReadTokens: Number(r.cache_read_tokens),
		cacheWriteTokens: Number(r.cache_write_tokens),
		costUsd: r.cost_usd === null ? null : Number(r.cost_usd),
		linesAdded: Number(r.lines_added),
		linesRemoved: Number(r.lines_removed),
	});

	return {
		days,
		from,
		to,
		users: userRows.map((r) => ({
			userId: r.user_id,
			displayName: r.display_name,
			agent: CodingAgent.parse(r.agent),
			...counts(r as never),
		})),
		daily: dayRows.map((r) => ({
			day: r.day,
			agent: CodingAgent.parse(r.agent),
			...counts(r),
		})),
	};
}

/**
 * Coding-agent usage for instructors and administrators (SPEC.md §25.10,
 * ADR 0057). The course view covers the course's members and counts their
 * use outside the course too; the admin view covers everyone.
 */
export function registerAgentUsageRoutes(
	app: FastifyInstance,
	{ db }: ServerDeps,
): void {
	app.get("/courses/:courseId/agent-usage", async (request, reply) => {
		const user = requireUser(request);
		const params = CourseParam.safeParse(request.params);
		if (!params.success) return sendError(reply, 404, "NOT_FOUND", "Not found.");
		const { courseId } = params.data;
		if (!(await teachesCourse(db, { userId: user.id, courseId }))) {
			return sendError(reply, 404, "NOT_FOUND", "Not found.");
		}
		const query = AgentUsageQuery.safeParse(request.query);
		if (!query.success)
			return sendError(reply, 400, "VALIDATION_FAILED", "days must be 7, 30 or 90.");

		const members = await db
			.selectFrom("lti_memberships")
			.select("user_id")
			.where("context_id", "=", courseId)
			.execute();
		const memberIds = members.map((m) => m.user_id);
		return reply.send(await usageFor(db, query.data.days, memberIds, new Date()));
	});

	app.get(
		"/admin/agent-usage",
		{ preHandler: requireRole("administrator") },
		async (request, reply) => {
			const query = AgentUsageQuery.safeParse(request.query);
			if (!query.success)
				return sendError(reply, 400, "VALIDATION_FAILED", "days must be 7, 30 or 90.");
			return reply.send(await usageFor(db, query.data.days, null, new Date()));
		},
	);
}
