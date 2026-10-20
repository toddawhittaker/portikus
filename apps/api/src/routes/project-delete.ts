import { requireUser } from "@portikus/auth";
import { DeleteProjectRequest } from "@portikus/contracts";
import { type Database, recordAudit } from "@portikus/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import { AgentCallError, type AgentClient } from "../agent-client.js";
import { ProjectParam, parseOr400, sendError } from "../http.js";
import {
	claimLongOperation,
	releaseLongOperation,
} from "../workspaces/long-operation.js";
import {
	type ProjectRow,
	requireAgent,
	type Scope,
	sendAgentError,
} from "../workspaces/project-scope.js";

export function registerProjectDeleteRoute(
	app: FastifyInstance,
	db: Kysely<Database>,
	limitWrites: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
	owned: (request: FastifyRequest, reply: FastifyReply) => Promise<Scope | null>,
	ownedProject: (
		workspaceId: string,
		projectId: string,
		reply: FastifyReply,
	) => Promise<ProjectRow | null>,
): void {
	// Permanent (SPEC.md §7.3, §24.11).
	app.delete(
		"/workspaces/:id/projects/:pid",
		{ preHandler: limitWrites },
		async (request, reply) => {
			const user = requireUser(request);
			const params = parseOr400(ProjectParam, request.params, reply);
			if (!params) return;
			const scope = await owned(request, reply);
			if (!scope) return;
			const body = DeleteProjectRequest.safeParse(request.body ?? {});
			if (!body.success) {
				return sendError(reply, 400, "VALIDATION_FAILED", body.error.message);
			}
			const row = await ownedProject(scope.workspaceId, params.pid, reply);
			if (!row) return;
			// Typing the folder name back is the whole safeguard, so it is checked
			// against the row rather than anything the browser chose.
			if (body.data.slug !== row.slug) {
				return sendError(
					reply,
					400,
					"VALIDATION_FAILED",
					"The slug you typed does not match",
				);
			}
			const agent = requireAgent(scope, reply);
			if (!agent) return;

			// Removing a tree can take a while, and a copy running at the same time
			// would read directories this is deleting.
			if (!claimLongOperation(scope.workspaceId, reply)) return;
			try {
				return await deleteProjectTree(request, reply, scope, row, agent, user.id);
			} finally {
				releaseLongOperation(scope.workspaceId);
			}
		},
	);

	/** The slow half of the delete, so the slot is released on every exit. */
	async function deleteProjectTree(
		request: FastifyRequest,
		reply: FastifyReply,
		scope: Scope,
		row: ProjectRow,
		agent: AgentClient,
		userId: string,
	): Promise<FastifyReply | undefined> {
		// A terminal created in the directory that is about to go must end
		// first, or its shell keeps a deleted working directory (SPEC.md §9.3).
		// `terminals.cwd` is only the directory it started in, so one that
		// moved in or out of the project by `cd` is not matched.
		const open = await db
			.selectFrom("terminals")
			.selectAll()
			.where("workspace_id", "=", scope.workspaceId)
			.where("ended_at", "is", null)
			.execute();
		const inside = open.filter(
			(terminal) =>
				terminal.cwd === row.path || terminal.cwd.startsWith(`${row.path}/`),
		);
		for (const terminal of inside) {
			try {
				await agent.deleteTerminal(terminal.id);
			} catch (error) {
				// A session the agent has already lost is still an ended terminal.
				if (!(error instanceof AgentCallError)) throw error;
			}
			await db
				.updateTable("terminals")
				.set({ ended_at: new Date().toISOString() })
				.where("id", "=", terminal.id)
				.execute();
		}

		try {
			await agent.deleteProject(row.slug);
		} catch (error) {
			// A directory that is already gone still leaves a row to remove.
			const gone =
				error instanceof AgentCallError && error.code === "PROJECT_NOT_FOUND";
			if (!gone) return sendAgentError(reply, error);
		}

		// The rows go by cascade; the archives are the agent's to remove. A
		// leftover directory only costs recovery space, so it does not block.
		try {
			await agent.deleteProjectRecoveryPoints(row.id);
		} catch (error) {
			if (!(error instanceof AgentCallError)) throw error;
			request.log.warn(
				{ workspaceId: scope.workspaceId, projectId: row.id, code: error.code },
				"recovery points of a deleted project were not removed",
			);
		}

		await db.transaction().execute(async (trx) => {
			await trx.deleteFrom("projects").where("id", "=", row.id).execute();
			await recordAudit(trx, {
				actor: `user:${userId}`,
				target: row.id,
				action: "project.deleted",
				result: "ok",
				metadata: {
					slug: row.slug,
					name: row.name,
					ip: request.ip,
				},
			});
		});

		request.log.info(
			{ workspaceId: scope.workspaceId, projectId: row.id, slug: row.slug },
			"project deleted",
		);
		return reply.status(204).send();
	}
}
