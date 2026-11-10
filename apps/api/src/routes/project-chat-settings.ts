import { ChatLastSettings, StoredChatSettings } from "@portikus/contracts";
import type { Database } from "@portikus/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { type Kysely, sql } from "kysely";
import { z } from "zod";
import { ProjectParam, parseOr400, sendError } from "../http.js";
import type { OwnedProject, OwnedScope } from "../workspaces/project-scope.js";

/** The read-aloud switch saved on its own, so it never rewrites the pickers. */
const ReadAloudOnly = z.object({ readAloud: z.boolean() }).strict();

/**
 * The chat picker values the owner last used in one project, which a new
 * chat there starts with (SPEC.md §10.8), and whether replies are read
 * aloud (ADR 0071). Only these values are kept, never anything from the
 * conversation (ADR 0012). A save changes the keys it names and keeps the
 * rest, in one statement, so the pickers and the switch cannot overwrite
 * each other.
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
			const body = ChatLastSettings.or(ReadAloudOnly).safeParse(request.body ?? {});
			if (!body.success) {
				return sendError(reply, 400, "VALIDATION_FAILED", body.error.message);
			}
			const row = await ownedProject(scope.workspaceId, params.pid, reply);
			if (!row) return;
			// Only the keys sent. The stored form turns Bypass into Auto.
			const { readAloud, ...pickers } = body.data;
			let changed: Record<string, unknown> =
				readAloud === undefined ? {} : { readAloud };
			if ("model" in pickers) {
				const { model, effort, mode } = StoredChatSettings.parse(pickers);
				changed = { ...changed, model, effort, mode };
			}
			// Left to right: the default, what is stored, then what was sent.
			await db
				.updateTable("projects")
				.set({
					chat_settings: sql<string>`'{"readAloud": false}'::jsonb || coalesce(chat_settings, '{}'::jsonb) || ${JSON.stringify(changed)}::jsonb`,
				})
				.where("id", "=", row.id)
				.execute();
			return reply.status(204).send();
		},
	);
}
