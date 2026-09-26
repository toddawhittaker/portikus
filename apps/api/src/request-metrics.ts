import type { Database } from "@portikus/db";
import type { Logger } from "@portikus/observability";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { type Kysely, sql } from "kysely";

/** Upper bounds of the latency histogram; one overflow bucket follows (docs/EPIC-19.md ruling 22). */
export const API_LATENCY_BOUNDS_MS = [
	5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000,
] as const;

export const API_REQUEST_RETENTION_DAYS = 7;

const MINUTE_MS = 60_000;
const PRUNE_EVERY_MS = 3_600_000;

interface MinuteCounts {
	minute: number;
	requests: number;
	clientErrors: number;
	serverErrors: number;
	webSocketUpgrades: number;
	latency: number[];
}

/** The histogram index for a response time: the first bound it does not exceed. */
export function latencyBucket(ms: number): number {
	const index = API_LATENCY_BOUNDS_MS.findIndex((bound) => ms <= bound);
	return index === -1 ? API_LATENCY_BOUNDS_MS.length : index;
}

function emptyMinute(minute: number): MinuteCounts {
	return {
		minute,
		requests: 0,
		clientErrors: 0,
		serverErrors: 0,
		webSocketUpgrades: 0,
		latency: new Array(API_LATENCY_BOUNDS_MS.length + 1).fill(0),
	};
}

function isUpgrade(request: FastifyRequest): boolean {
	const upgrade = request.headers.upgrade;
	return typeof upgrade === "string" && upgrade.toLowerCase() === "websocket";
}

function pathOf(url: string): string {
	const query = url.indexOf("?");
	return query === -1 ? url : url.slice(0, query);
}

export interface RequestMetricsOptions {
	db: Kysely<Database>;
	logger: Logger;
	now?: () => Date;
	/** How often finished minutes are written; tests go faster. */
	flushIntervalMs?: number;
}

/**
 * Count every API response per minute and write the totals to
 * `api_request_samples` (docs/EPIC-19.md rulings 20 to 24). Only counts and
 * a latency histogram are kept: no route, path, user or workspace.
 */
export function registerRequestMetrics(
	app: FastifyInstance,
	options: RequestMetricsOptions,
): void {
	const { db, logger } = options;
	const now = options.now ?? (() => new Date());
	const flushIntervalMs = options.flushIntervalMs ?? MINUTE_MS;
	const finished: MinuteCounts[] = [];
	let current = emptyMinute(minuteOf(now()));
	let lastPrune = 0;
	let timer: NodeJS.Timeout | undefined;

	function minuteOf(at: Date): number {
		return Math.floor(at.getTime() / MINUTE_MS) * MINUTE_MS;
	}

	function currentMinute(): MinuteCounts {
		const minute = minuteOf(now());
		if (minute !== current.minute) {
			finished.push(current);
			current = emptyMinute(minute);
		}
		return current;
	}

	async function write(counts: MinuteCounts): Promise<void> {
		if (counts.requests === 0 && counts.webSocketUpgrades === 0) return;
		await sql`
			insert into api_request_samples
				(minute, requests, client_errors, server_errors, websocket_upgrades, latency_buckets)
			values (${new Date(counts.minute)}, ${counts.requests}, ${counts.clientErrors},
				${counts.serverErrors}, ${counts.webSocketUpgrades}, ${counts.latency}::int[])
			on conflict (minute) do update set
				requests = api_request_samples.requests + excluded.requests,
				client_errors = api_request_samples.client_errors + excluded.client_errors,
				server_errors = api_request_samples.server_errors + excluded.server_errors,
				websocket_upgrades = api_request_samples.websocket_upgrades + excluded.websocket_upgrades,
				latency_buckets = (
					select array_agg(coalesce(a, 0) + coalesce(b, 0) order by i)
					from unnest(api_request_samples.latency_buckets, excluded.latency_buckets)
						with ordinality as u(a, b, i)
				)
		`.execute(db);
	}

	async function flush(): Promise<void> {
		currentMinute();
		const due = finished.splice(0);
		for (const counts of due) {
			try {
				await write(counts);
			} catch (e) {
				// Dropped, not retried: one lost minute beats a retry loop.
				logger.warn(
					{ error: e instanceof Error ? e.message : String(e) },
					"api request metrics write failed",
				);
			}
		}
		const at = now().getTime();
		if (at - lastPrune >= PRUNE_EVERY_MS) {
			lastPrune = at;
			try {
				await db
					.deleteFrom("api_request_samples")
					.where("minute", "<", new Date(at - API_REQUEST_RETENTION_DAYS * 86_400_000))
					.execute();
			} catch (e) {
				logger.warn(
					{ error: e instanceof Error ? e.message : String(e) },
					"api request metrics prune failed",
				);
			}
		}
	}

	// An accepted upgrade is hijacked and never reaches onResponse, so count it here.
	app.addHook("onRequest", async (request) => {
		if (isUpgrade(request)) currentMinute().webSocketUpgrades += 1;
	});

	app.addHook("onResponse", async (request, reply) => {
		if (isUpgrade(request) || pathOf(request.url) === "/health") return;
		const counts = currentMinute();
		counts.requests += 1;
		if (reply.statusCode >= 500) counts.serverErrors += 1;
		else if (reply.statusCode >= 400) counts.clientErrors += 1;
		const bucket = latencyBucket(reply.elapsedTime);
		counts.latency[bucket] = (counts.latency[bucket] ?? 0) + 1;
	});

	app.addHook("onReady", async () => {
		timer = setInterval(() => void flush(), flushIntervalMs);
		timer.unref();
	});

	app.addHook("onClose", async () => {
		if (timer) clearInterval(timer);
		finished.push(current);
		current = emptyMinute(minuteOf(now()));
		await flush();
	});
}
