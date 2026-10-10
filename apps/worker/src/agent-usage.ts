import { AGENT_USAGE_RETENTION_DAYS, type AgentUsageReport } from "@portikus/contracts";
import type { Database } from "@portikus/db";
import { errorMessage, type Logger } from "@portikus/observability";
import { type Kysely, sql } from "kysely";
import { fetchAgentUsage } from "./agent-client.js";
import { startLoop } from "./loop.js";

/** How often every running workspace's coding-agent usage is read (ADR 0057). */
export const AGENT_USAGE_POLL_SECONDS = 5 * 60;
const PRUNE_SECONDS = 24 * 60 * 60;
const UPSERT_CHUNK = 500;

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
		try {
			const workspaces = await db
				.selectFrom("workspaces")
				.select(["owner_user_id", "agent_address", "agent_token"])
				.where("state", "=", "running")
				.where("agent_address", "is not", null)
				.where("agent_token", "is not", null)
				.execute();
			let read = 0;
			for (const ws of workspaces) {
				if (!ws.agent_address || !ws.agent_token) continue;
				const report = await readUsage(ws.agent_address, ws.agent_token);
				if (!report) continue;
				await storeAgentUsage(db, ws.owner_user_id, report, now());
				read++;
			}
			logger.info({ workspaces: workspaces.length, read }, "agent usage read");
		} catch (e) {
			logger.warn({ error: errorMessage(e) }, "agent usage read failed");
		}
	};
}

/** Upsert a report's rows as absolute values under its boot id. */
export async function storeAgentUsage(
	db: Kysely<Database>,
	userId: string,
	report: AgentUsageReport,
	at: Date,
): Promise<void> {
	const updatedAt = at.toISOString();
	for (let i = 0; i < report.rows.length; i += UPSERT_CHUNK) {
		await db
			.insertInto("agent_usage_days")
			.values(
				report.rows.slice(i, i + UPSERT_CHUNK).map((r) => ({
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
}

/** Delete usage days older than AGENT_USAGE_RETENTION_DAYS (ADR 0057). */
export async function pruneAgentUsage(db: Kysely<Database>, now: Date): Promise<void> {
	const cutoff = new Date(now.getTime() - AGENT_USAGE_RETENTION_DAYS * 86_400_000)
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
