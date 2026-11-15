import { readJson as readCappedJson } from "@portikus/agent-client";
import {
	CHECK_HISTORY_PER_CHECK,
	CheckHistoryOutput,
	type CheckHistoryResponse,
	CheckId,
	FinishedCheckRunsResponse,
	MAX_HELD_FINISHED_RUNS,
	MAX_STORED_CHECK_OUTPUT_BYTES,
} from "@portikus/contracts";
import type { Database } from "@portikus/db";
import { errorMessage } from "@portikus/observability";
import type {
	FastifyBaseLogger,
	FastifyInstance,
	FastifyReply,
	FastifyRequest,
} from "fastify";
import type { Kysely } from "kysely";
import { z } from "zod";
import { AGENT_TIMEOUT_MS, type AgentClient } from "../agent-client.js";
import type { ServerDeps } from "../deps.js";
import { ProjectParam, sendError } from "../http.js";
import { agentUrl, ownedProject, ownedScope } from "../workspaces/project-scope.js";

/** A full hold of finished runs, base64 output and all, with room for the fields. */
const FINISHED_LIMIT_BYTES =
	MAX_HELD_FINISHED_RUNS * (Math.ceil(MAX_STORED_CHECK_OUTPUT_BYTES / 3) * 4 + 1024);

const RunId = z.string().uuid();

/**
 * Read the finished runs the workspace agent holds for one project and keep
 * them under that project, the newest CHECK_HISTORY_PER_CHECK per check
 * (SPEC.md §25). The project id comes from the caller's own workspace, never
 * from the agent, so a workspace can only add runs to its own projects
 * (SPEC.md §24.1). Output is student content and is never logged.
 */
async function storeFinishedRuns(
	db: Kysely<Database>,
	agent: AgentClient,
	projectId: string,
	slug: string,
): Promise<void> {
	const response = await agent.fetchRaw("GET", agentUrl(slug, "checks/finished"), {
		signal: AbortSignal.timeout(AGENT_TIMEOUT_MS),
	});
	if (!response.ok) throw new Error(`agent answered ${response.status}`);
	const parsed = FinishedCheckRunsResponse.safeParse(
		await readCappedJson(response, FINISHED_LIMIT_BYTES),
	);
	if (!parsed.success)
		throw new Error("the agent's finished runs did not fit the contract");
	if (parsed.data.runs.length === 0) return;
	await db.transaction().execute(async (trx) => {
		await trx
			.insertInto("check_runs")
			.values(
				parsed.data.runs.map((run) => ({
					project_id: projectId,
					check_id: run.checkId,
					agent_run_id: run.id,
					state: run.state,
					started_at: run.startedAt,
					ended_at: run.endedAt,
					exit_code: run.exitCode,
					output: Buffer.from(run.output, "base64"),
				})),
			)
			.onConflict((oc) =>
				oc.columns(["project_id", "check_id", "agent_run_id"]).doNothing(),
			)
			.execute();
		const checkIds = [...new Set(parsed.data.runs.map((run) => run.checkId))];
		await pruneCheckRuns(trx, projectId, checkIds);
	});
}

/** Delete all but the newest CHECK_HISTORY_PER_CHECK runs of each check. */
export async function pruneCheckRuns(
	db: Kysely<Database>,
	projectId: string,
	checkIds: string[],
): Promise<void> {
	for (const checkId of checkIds) {
		const keep = db
			.selectFrom("check_runs")
			.select("id")
			.where("project_id", "=", projectId)
			.where("check_id", "=", checkId)
			.orderBy("started_at", "desc")
			.orderBy("id", "desc")
			.limit(CHECK_HISTORY_PER_CHECK);
		await db
			.deleteFrom("check_runs")
			.where("project_id", "=", projectId)
			.where("check_id", "=", checkId)
			.where("id", "not in", keep)
			.execute();
	}
}

/**
 * The caller's own project and the check named in the route, or null after
 * answering. Ownership is settled before the check id is read, so a caller
 * who does not own the workspace always gets the same 404 (SPEC.md §24.6).
 */
async function ownCheck(
	db: Kysely<Database>,
	deps: ServerDeps,
	request: FastifyRequest,
	reply: FastifyReply,
) {
	const params = ProjectParam.safeParse(request.params);
	if (!params.success) {
		sendError(reply, 400, "VALIDATION_FAILED", params.error.message);
		return null;
	}
	const scope = await ownedScope(db, deps.config, request, reply);
	if (!scope) return null;
	const row = await ownedProject(db, scope.workspaceId, params.data.pid, reply);
	if (!row) return null;
	const checkId = CheckId.safeParse((request.params as { checkId?: unknown }).checkId);
	if (!checkId.success) {
		sendError(reply, 400, "VALIDATION_FAILED", "that is not a check id");
		return null;
	}
	return { scope, row, checkId: checkId.data };
}

async function syncQuietly(
	db: Kysely<Database>,
	agent: AgentClient,
	projectId: string,
	slug: string,
	log: FastifyBaseLogger,
): Promise<void> {
	try {
		await storeFinishedRuns(db, agent, projectId, slug);
	} catch (error) {
		// What is already stored still answers; the next read tries again.
		log.warn({ error: errorMessage(error) }, "could not read finished check runs");
	}
}

/**
 * Check history for the student's own project (SPEC.md §18.1, §25). It works
 * while the workspace is stopped, from what is stored; while it runs, the
 * agent's newly finished runs are stored first.
 */
export function registerCheckHistoryRoutes(
	app: FastifyInstance,
	deps: ServerDeps,
): void {
	const { db } = deps;

	app.get(
		"/workspaces/:id/projects/:pid/checks/:checkId/history",
		async (request, reply) => {
			const owned = await ownCheck(db, deps, request, reply);
			if (!owned) return;
			if (owned.scope.agent) {
				await syncQuietly(
					db,
					owned.scope.agent,
					owned.row.id,
					owned.row.slug,
					request.log,
				);
			}
			const rows = await db
				.selectFrom("check_runs")
				.select(["id", "check_id", "state", "started_at", "ended_at", "exit_code"])
				.where("project_id", "=", owned.row.id)
				.where("check_id", "=", owned.checkId)
				.orderBy("started_at", "desc")
				.orderBy("id", "desc")
				.limit(CHECK_HISTORY_PER_CHECK)
				.execute();
			const body: CheckHistoryResponse = {
				runs: rows.map((row) => ({
					id: row.id,
					checkId: row.check_id,
					state: row.state,
					startedAt: row.started_at.toISOString(),
					endedAt: row.ended_at.toISOString(),
					durationMs: Math.max(0, row.ended_at.getTime() - row.started_at.getTime()),
					exitCode: row.exit_code,
				})),
			};
			return body;
		},
	);

	app.get(
		"/workspaces/:id/projects/:pid/checks/:checkId/history/:runId/output",
		async (request, reply) => {
			const owned = await ownCheck(db, deps, request, reply);
			if (!owned) return;
			const runId = RunId.safeParse((request.params as { runId?: unknown }).runId);
			const row = runId.success
				? await db
						.selectFrom("check_runs")
						.select("output")
						.where("id", "=", runId.data)
						.where("project_id", "=", owned.row.id)
						.where("check_id", "=", owned.checkId)
						.executeTakeFirst()
				: undefined;
			if (!row)
				return sendError(reply, 404, "NOT_FOUND", "That run is no longer kept.");
			return CheckHistoryOutput.parse({ output: row.output.toString("base64") });
		},
	);
}
