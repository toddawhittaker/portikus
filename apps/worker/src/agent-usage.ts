import {
	AGENT_USAGE_REPORT_DAYS,
	AGENT_USAGE_RETENTION_DAYS,
	type AgentUsageReport,
	type AgentUsageReportRow,
} from "@portikus/contracts";
import type { Database } from "@portikus/db";
import { errorMessage, type Logger } from "@portikus/observability";
import { type Kysely, sql } from "kysely";
import { fetchAgentUsage } from "./agent-client.js";
import { startLoop } from "./loop.js";

/** How often every running workspace's coding-agent usage is read (ADR 0057). */
export const AGENT_USAGE_POLL_SECONDS = 5 * 60;
const PRUNE_SECONDS = 24 * 60 * 60;
const UPSERT_CHUNK = 500;
const DAY_MS = 86_400_000;

/**
 * Most boots stored per person and day. A real workspace restarts a few
 * times a day; a forged boot id on every poll would otherwise add rows forever.
 */
export const MAX_AGENT_USAGE_BOOTS_PER_DAY = 5;

type UsageReader = (address: string, token: string) => Promise<AgentUsageReport | null>;

export interface AgentUsageOptions {
	db: Kysely<Database>;
	logger: Logger;
	readUsage: UsageReader;
	now?: () => Date;
}

/**
 * Build the usage tick: read each running workspace's totals through its
 * agent and store them under the owner. A row holds its boot's running
 * total, so storing the same report twice changes nothing. A failed read
 * is no data: the rows already stored stay.
 */
export function createAgentUsagePoll(options: AgentUsageOptions): () => Promise<void> {
	const { db, logger, readUsage } = options;
	const now = options.now ?? (() => new Date());

	return async function tick(): Promise<void> {
		let workspaces: {
			owner_user_id: string;
			agent_address: string | null;
			agent_token: string | null;
		}[];
		try {
			workspaces = await db
				.selectFrom("workspaces")
				.select(["owner_user_id", "agent_address", "agent_token"])
				.where("state", "=", "running")
				.where("agent_address", "is not", null)
				.where("agent_token", "is not", null)
				.execute();
		} catch (e) {
			logger.warn({ error: errorMessage(e) }, "agent usage read failed");
			return;
		}
		let read = 0;
		let failed = 0;
		const refused: StoreAgentUsageResult = { outsideWindow: 0, overBootCap: 0 };
		for (const ws of workspaces) {
			if (!ws.agent_address || !ws.agent_token) continue;
			// One workspace's report must not cost the others theirs.
			try {
				const report = await readUsage(ws.agent_address, ws.agent_token);
				if (!report) continue;
				const result = await storeAgentUsage(db, ws.owner_user_id, report, now());
				refused.outsideWindow += result.outsideWindow;
				refused.overBootCap += result.overBootCap;
				read++;
			} catch (e) {
				failed++;
				logger.warn({ error: errorMessage(e) }, "agent usage store failed");
			}
		}
		if (refused.outsideWindow > 0 || refused.overBootCap > 0) {
			logger.warn({ ...refused }, "agent usage rows refused");
		}
		logger.info({ workspaces: workspaces.length, read, failed }, "agent usage read");
	};
}

/** Rows refused from one report, by reason. */
export interface StoreAgentUsageResult {
	/** Not a real calendar day, or outside the days a report can reach. */
	outsideWindow: number;
	/** For a day that already holds MAX_AGENT_USAGE_BOOTS_PER_DAY other boots. */
	overBootCap: number;
}

/**
 * Upsert a report's rows as absolute values under its boot id. Any process
 * in the workspace can shape a report, so a row is refused for a day that
 * is not real, is outside [today - AGENT_USAGE_REPORT_DAYS, today + 1], or
 * already has the most boots.
 */
export async function storeAgentUsage(
	db: Kysely<Database>,
	userId: string,
	report: AgentUsageReport,
	at: Date,
): Promise<StoreAgentUsageResult> {
	const inWindow = report.rows.filter((r) => dayInWindow(r.day, at));
	const fullDays = await daysAtBootCap(db, userId, report.bootId, inWindow);
	const rows = inWindow.filter((r) => !fullDays.has(r.day));
	const updatedAt = at.toISOString();
	for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
		await db
			.insertInto("agent_usage_days")
			.values(
				rows.slice(i, i + UPSERT_CHUNK).map((r) => ({
					user_id: userId,
					boot_id: report.bootId,
					day: r.day,
					agent: r.agent,
					model: r.model,
					sessions: r.sessions,
					input_tokens: r.inputTokens,
					output_tokens: r.outputTokens,
					cache_read_tokens: r.cacheReadTokens,
					cache_write_tokens: r.cacheWriteTokens,
					cost_usd: r.costUsd,
					lines_added: r.linesAdded,
					lines_removed: r.linesRemoved,
					updated_at: updatedAt,
				})),
			)
			.onConflict((oc) =>
				oc
					.columns(["user_id", "boot_id", "day", "agent", "model"])
					.doUpdateSet((eb) => ({
						sessions: eb.ref("excluded.sessions"),
						input_tokens: eb.ref("excluded.input_tokens"),
						output_tokens: eb.ref("excluded.output_tokens"),
						cache_read_tokens: eb.ref("excluded.cache_read_tokens"),
						cache_write_tokens: eb.ref("excluded.cache_write_tokens"),
						cost_usd: eb.ref("excluded.cost_usd"),
						lines_added: eb.ref("excluded.lines_added"),
						lines_removed: eb.ref("excluded.lines_removed"),
						updated_at: eb.ref("excluded.updated_at"),
					})),
			)
			.execute();
	}
	return {
		outsideWindow: report.rows.length - inWindow.length,
		overBootCap: inWindow.length - rows.length,
	};
}

/** A real YYYY-MM-DD calendar day within the days a report can reach. */
function dayInWindow(day: string, at: Date): boolean {
	const time = Date.parse(`${day}T00:00:00Z`);
	// Date.parse rolls 2026-02-31 over to March, so the round trip catches it.
	if (Number.isNaN(time) || new Date(time).toISOString().slice(0, 10) !== day) {
		return false;
	}
	const today = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
	return time >= today - AGENT_USAGE_REPORT_DAYS * DAY_MS && time <= today + DAY_MS;
}

/** The days among `rows` that already hold the most boots, none of them `bootId`. */
async function daysAtBootCap(
	db: Kysely<Database>,
	userId: string,
	bootId: string,
	rows: AgentUsageReportRow[],
): Promise<Set<string>> {
	const days = [...new Set(rows.map((r) => r.day))];
	if (days.length === 0) return new Set();
	const counts = await db
		.selectFrom("agent_usage_days")
		.select([
			sql<string>`to_char(day, 'YYYY-MM-DD')`.as("day"),
			sql<number>`count(distinct boot_id)::int`.as("boots"),
			sql<boolean>`bool_or(boot_id = ${bootId}::uuid)`.as("ours"),
		])
		.where("user_id", "=", userId)
		.where(sql<boolean>`day = any(${days}::date[])`)
		.groupBy("day")
		.execute();
	return new Set(
		counts
			.filter((c) => !c.ours && c.boots >= MAX_AGENT_USAGE_BOOTS_PER_DAY)
			.map((c) => c.day),
	);
}

/** Delete usage days older than AGENT_USAGE_RETENTION_DAYS (ADR 0057). */
export async function pruneAgentUsage(db: Kysely<Database>, now: Date): Promise<void> {
	const cutoff = new Date(now.getTime() - AGENT_USAGE_RETENTION_DAYS * DAY_MS)
		.toISOString()
		.slice(0, 10);
	await db
		.deleteFrom("agent_usage_days")
		.where("day", "<", sql<Date>`${cutoff}::date`)
		.execute();
}

/** Start the usage poll and the daily prune; returns a stop function. */
export function startAgentUsage(
	options: Omit<AgentUsageOptions, "readUsage"> & { agentPort: number },
): () => void {
	const tick = createAgentUsagePoll({
		...options,
		readUsage: (address, token) => fetchAgentUsage(address, options.agentPort, token),
	});
	const now = options.now ?? (() => new Date());
	const prune = async (): Promise<void> => {
		try {
			await pruneAgentUsage(options.db, now());
		} catch (e) {
			options.logger.warn({ error: errorMessage(e) }, "agent usage prune failed");
		}
	};
	const stopPoll = startLoop(
		"agent usage",
		options.logger,
		tick,
		AGENT_USAGE_POLL_SECONDS * 1000,
	);
	const stopPrune = startLoop(
		"agent usage prune",
		options.logger,
		prune,
		PRUNE_SECONDS * 1000,
	);
	return () => {
		stopPoll();
		stopPrune();
	};
}
