import { requireRole } from "@portikus/auth";
import {
	type AiPurpose,
	AiUsageQuery,
	type AiUsageResponse,
} from "@portikus/contracts";
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { loadAiSettings } from "../ai/settings.js";
import { usedThisMonth } from "../ai/usage.js";
import type { ServerDeps } from "../deps.js";
import { sendError } from "../http.js";
import { windowDays } from "../usage-window.js";

const total = (col: string) => sql<string>`sum(${sql.ref(col)})::text`;

const sumColumns = [
	total("u.input_tokens").as("input_tokens"),
	total("u.output_tokens").as("output_tokens"),
	total("u.cache_read_tokens").as("cache_read_tokens"),
	total("u.cache_write_tokens").as("cache_write_tokens"),
] as const;

function counts(r: {
	input_tokens: string;
	output_tokens: string;
	cache_read_tokens: string;
	cache_write_tokens: string;
}) {
	return {
		inputTokens: Number(r.input_tokens),
		outputTokens: Number(r.output_tokens),
		cacheReadTokens: Number(r.cache_read_tokens),
		cacheWriteTokens: Number(r.cache_write_tokens),
	};
}

/** Who a row with no person belongs to: the weekly timer, or a person since deleted. */
function nameFor(displayName: string | null, purpose: AiPurpose): string {
	if (displayName) return displayName;
	return purpose === "pricing" ? "Weekly price check" : "Deleted user";
}

/**
 * Built-in AI usage for administrators (SPEC.md section 20.4): token counts
 * by person and by day, and this month's use against the monthly cap.
 * Counts only, never any conversation text.
 */
export function registerAdminAiUsageRoutes(
	app: FastifyInstance,
	{ db }: ServerDeps,
): void {
	app.get(
		"/admin/ai-usage",
		{ preHandler: requireRole("administrator") },
		async (request, reply) => {
			const query = AiUsageQuery.safeParse(request.query);
			if (!query.success)
				return sendError(reply, 400, "VALIDATION_FAILED", "days must be 7, 30 or 90.");
			const now = new Date();
			const { from, to } = windowDays(query.data.days, now);
			const base = () =>
				db
					.selectFrom("ai_usage_days as u")
					.where(sql<boolean>`u.day >= ${from}::date and u.day <= ${to}::date`);

			const userRows = await base()
				.leftJoin("users", "users.id", "u.user_id")
				.select([
					"u.user_id",
					"users.display_name",
					"u.purpose",
					"u.model",
					...sumColumns,
				])
				.groupBy(["u.user_id", "users.display_name", "u.purpose", "u.model"])
				.orderBy(sql`sum(u.input_tokens + u.output_tokens)`, "desc")
				.orderBy("users.display_name")
				.orderBy("u.model")
				.execute();
			const dayRows = await base()
				.select([
					sql<string>`to_char(u.day, 'YYYY-MM-DD')`.as("day"),
					"u.purpose",
					...sumColumns,
				])
				.groupBy(["u.day", "u.purpose"])
				.orderBy("u.day")
				.orderBy("u.purpose")
				.execute();

			const users = userRows.map((r) => ({
				userId: r.user_id,
				displayName: nameFor(r.display_name, r.purpose),
				purpose: r.purpose,
				model: r.model,
				...counts(r),
			}));
			const totals = users.reduce(
				(sum, row) => ({
					inputTokens: sum.inputTokens + row.inputTokens,
					outputTokens: sum.outputTokens + row.outputTokens,
					cacheReadTokens: sum.cacheReadTokens + row.cacheReadTokens,
					cacheWriteTokens: sum.cacheWriteTokens + row.cacheWriteTokens,
				}),
				{ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
			);
			const body: AiUsageResponse = {
				days: query.data.days,
				from,
				to,
				users,
				daily: dayRows.map((r) => ({ day: r.day, purpose: r.purpose, ...counts(r) })),
				totals,
				month: {
					usedTokens: await usedThisMonth(db, now),
					capTokens: (await loadAiSettings(db)).monthlyTokenCap,
				},
			};
			return reply.header("cache-control", "no-store").send(body);
		},
	);
}
