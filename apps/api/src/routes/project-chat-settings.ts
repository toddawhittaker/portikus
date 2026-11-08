import { ChatLastSettings, StoredChatSettings } from "@portikus/contracts";
import type { Database } from "@portikus/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import { ProjectParam, parseOr400, sendError } from "../http.js";
import type { OwnedProject, OwnedScope } from "../workspaces/project-scope.js";

/**
 * The chat picker values the owner last used in one project, which a new
 * chat there starts with (SPEC.md §10.8). Only the three values are kept,
 * never anything from the conversation (ADR 0012).
 */
export function registerProjectChatSettingsRoutes(
	app: FastifyInstance,
	db: Kysely<Database>,
	limitWrites: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
	owned: OwnedScope,
	ownedProject: OwnedProject,
): void {
	app.get("/workspaces/:id/projects/:pid/chat-settings", async (request, reply) => {
		const params = parseOr400(ProjectParam, request.params, reply);
		if (!params) return;
		const scope = await owned(request, reply);
		if (!scope) return;
		const row = await ownedProject(scope.workspaceId, params.pid, reply);
		if (!row) return;
		reply.header("cache-control", "no-store");
		if (row.chat_settings === null) return reply.status(204).send();
		return StoredChatSettings.parse(row.chat_settings);
	});

	app.put(
		"/workspaces/:id/projects/:pid/chat-settings",
		{ preHandler: limitWrites },
		async (request, reply) => {
			const params = parseOr400(ProjectParam, request.params, reply);
			if (!params) return;
			const scope = await owned(request, reply);
			if (!scope) return;
			const body = ChatLastSettings.safeParse(request.body ?? {});
			if (!body.success) {
				return sendError(reply, 400, "VALIDATION_FAILED", body.error.message);
			}
			const row = await ownedProject(scope.workspaceId, params.pid, reply);
			if (!row) return;
			await db
				.updateTable("projects")
				.set({ chat_settings: JSON.stringify(StoredChatSettings.parse(body.data)) })
				.where("id", "=", row.id)
				.execute();
			return reply.status(204).send();
		},
	);
}
