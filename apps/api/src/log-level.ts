import { LogLevel } from "@portikus/contracts";
import type { Database } from "@portikus/db";
import { applyLevel, type Logger } from "@portikus/observability";
import type { Kysely } from "kysely";
import { agentClientFor } from "./agent-client.js";

/** How often the API re-reads the runtime log level (ADR 0012). */
const DEFAULT_INTERVAL_MS = 5000;

export interface LogLevelSyncOptions {
	db: Kysely<Database>;
	logger: Logger;
	/** The level this process starts with, from LOG_LEVEL. */
	envLevel: LogLevel;
	agentPort: number;
	intervalMs?: number;
}

export interface LogLevelSync {
	stop(): void;
	/** One sweep, run by the interval; tests drive it directly. */
	tick(): Promise<void>;
}

/**
 * Follow `settings.log_level` and relay it to every running workspace's agent.
 *
 * The API holds the per-workspace agent tokens, so it is the process that can
 * make that hop. A push is best effort: a failure is logged at debug and tried
 * again on the next tick, and an agent that restarts keeps its own environment
 * level until the setting changes.
 */
export function startLogLevelSync(options: LogLevelSyncOptions): LogLevelSync {
	const { db, logger, envLevel, agentPort } = options;
	const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;

	/** The level each running workspace's agent has acknowledged. */
	const pushed = new Map<string, LogLevel>();
	let running = false;

	async function readOverride(): Promise<LogLevel | null> {
		const row = await db
			.selectFrom("settings")
			.select("log_level")
			.where("id", "=", 1)
			.executeTakeFirst();
		if (!row || row.log_level === null) return null;
		const parsed = LogLevel.safeParse(row.log_level);
		return parsed.success ? parsed.data : null;
	}

	async function pushToAgents(level: LogLevel): Promise<void> {
		const rows = await db
			.selectFrom("workspaces")
			.selectAll()
			.where("state", "=", "running")
			.execute();

		const stillRunning = new Set<string>();
		for (const row of rows) {
			const workspaceId = row.id as string;
			stillRunning.add(workspaceId);
			if (pushed.get(workspaceId) === level) continue;
			const agent = agentClientFor(row as Record<string, unknown>, agentPort);
			if (!agent) continue;
			try {
				await agent.setLogLevel(level);
				pushed.set(workspaceId, level);
			} catch (error) {
				logger.debug(
					{
						workspaceId,
						level,
						error: error instanceof Error ? error.message : String(error),
					},
					"could not set the workspace agent log level",
				);
			}
		}
		// A workspace that stopped must be pushed again when it comes back.
		for (const workspaceId of [...pushed.keys()]) {
			if (!stillRunning.has(workspaceId)) pushed.delete(workspaceId);
		}
	}

	async function tick(): Promise<void> {
		if (running) return;
		running = true;
		try {
			const level = applyLevel(logger, envLevel, await readOverride());
			await pushToAgents(level);
		} catch (error) {
			logger.debug(
				{ error: error instanceof Error ? error.message : String(error) },
				"log level sync failed",
			);
		} finally {
			running = false;
		}
	}

	const timer = setInterval(() => void tick(), intervalMs);
	// Do not keep the process alive for this.
	timer.unref();

	return {
		tick,
		stop() {
			clearInterval(timer);
		},
	};
}
