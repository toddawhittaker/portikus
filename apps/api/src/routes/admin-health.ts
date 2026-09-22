import { requireRole } from "@portikus/auth";
import { type HealthReport, HealthSample } from "@portikus/contracts";
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import type { ListeningRegistry } from "../preview/registry.js";
import type { ServerDeps } from "../server.js";

/** The worker samples every minute; older than this means it stopped. */
export const WORKER_STALE_AFTER_MS = 2 * 60_000;

/** How long an agent has to answer `/health` before it counts as down. */
export const AGENT_PROBE_TIMEOUT_MS = 2000;

/** Ask one agent whether it answers. Never throws. */
async function agentAnswers(
	address: string,
	port: number,
	token: string,
): Promise<boolean> {
	try {
		const response = await fetch(`http://${address}:${port}/health`, {
			// The token is the workspace's secret and is never logged.
			headers: { authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(AGENT_PROBE_TIMEOUT_MS),
		});
		await response.body?.cancel();
		return response.ok;
	} catch {
		return false;
	}
}

/**
 * `GET /admin/health` (SPEC.md §25.6). Host facts come from the newest
 * `health_samples` row the worker wrote; the rest are counts over the
 * database and a parallel probe of each running workspace's agent (ADR 0022).
 */
export function registerAdminHealthRoutes(
	app: FastifyInstance,
	{ db, config }: ServerDeps & { registry: ListeningRegistry },
): void {
	app.get(
		"/admin/health",
		{ preHandler: requireRole("administrator") },
		async (_request, reply) => {
			const newest = await db
				.selectFrom("health_samples")
				.select(["observed_at", "sample"])
				.orderBy("observed_at", "desc")
				.limit(1)
				.executeTakeFirst();
			const sample = newest ? HealthSample.safeParse(newest.sample) : null;
			const sampled = sample?.success ? sample.data : null;
			const sampledAt = newest ? new Date(newest.observed_at) : null;

			// Maxima per fifteen minutes over the last day, oldest first.
			const series = await sql<{
				at: Date;
				pool_used: string;
				pool_total: string;
				memory_used: string;
				memory_total: string;
				load1: number;
			}>`
				select
					date_bin('15 minutes', observed_at, timestamptz '2000-01-01') as at,
					max((sample->'host'->'pool'->>'usedBytes')::bigint) as pool_used,
					max((sample->'host'->'pool'->>'totalBytes')::bigint) as pool_total,
					max((sample->'host'->'memory'->>'usedBytes')::bigint) as memory_used,
					max((sample->'host'->'memory'->>'totalBytes')::bigint) as memory_total,
					max((sample->'host'->'loadAverage'->>0)::float8) as load1
				from health_samples
				where observed_at > now() - interval '24 hours'
					and jsonb_typeof(sample->'host') = 'object'
				group by 1
				order by 1
			`.execute(db);

			const states = await db
				.selectFrom("workspaces")
				.select(["state", sql<string>`count(*)`.as("count")])
				.groupBy("state")
				.execute();

			const counts = await sql<Record<string, string>>`
				select
					count(*) filter (where action = 'workspace.start_failed') as start_failures,
					count(*) filter (where action = 'workspace.stop_failed') as stop_failures,
					count(*) filter (where action = 'workspace.force_stop') as forced_stops,
					count(*) filter (where action = 'workspace.provision_failed') as provision_failures,
					count(*) filter (where action = 'controller.unreachable') as controller_outages,
					count(*) filter (
						where action = 'auth.login' and result in ('failed', 'denied')
					) as sign_in_failures,
					-- One preview.denied row stands for up to a minute of refusals.
					coalesce(sum(coalesce((metadata->>'count')::int, 1))
						filter (where action = 'preview.denied'), 0) as preview_refusals
				from audit_events
				where at > now() - interval '24 hours'
			`.execute(db);
			const count = (name: string) => Number(counts.rows[0]?.[name] ?? 0);

			const running = await db
				.selectFrom("workspaces")
				.select(["agent_address", "agent_token"])
				.where("state", "=", "running")
				.execute();
			const answers = await Promise.all(
				running.map((row) =>
					row.agent_address && row.agent_token
						? agentAnswers(row.agent_address, config.AGENT_PORT, row.agent_token)
						: Promise.resolve(false),
				),
			);

			const host = sampled?.host ?? null;
			const body: HealthReport = {
				sampledAt: sampledAt ? sampledAt.toISOString() : null,
				workerStale:
					sampledAt === null ||
					Date.now() - sampledAt.getTime() > WORKER_STALE_AFTER_MS,
				controller: sampled?.controller ?? {
					reachable: false,
					errorCode: null,
				},
				host: host
					? {
							loadAverage: host.loadAverage,
							cpuCount: host.cpuCount,
							memory: host.memory,
							pool: {
								usedBytes: host.pool.usedBytes,
								totalBytes: host.pool.totalBytes,
							},
							profileLimits: host.profileLimits,
							image: host.image,
						}
					: null,
				workspacesByState: Object.fromEntries(
					states.map((row) => [row.state, Number(row.count)]),
				),
				agents: {
					answering: answers.filter(Boolean).length,
					running: running.length,
				},
				last24h: {
					startFailures: count("start_failures"),
					stopFailures: count("stop_failures"),
					forcedStops: count("forced_stops"),
					provisionFailures: count("provision_failures"),
					controllerOutages: count("controller_outages"),
					signInFailures: count("sign_in_failures"),
					previewRefusals: count("preview_refusals"),
				},
				series: series.rows.map((row) => ({
					at: new Date(row.at).toISOString(),
					poolUsedBytes: Number(row.pool_used),
					poolTotalBytes: Number(row.pool_total),
					memoryUsedBytes: Number(row.memory_used),
					memoryTotalBytes: Number(row.memory_total),
					load1: Number(row.load1),
				})),
			};
			return reply.header("cache-control", "no-store").send(body);
		},
	);
}
