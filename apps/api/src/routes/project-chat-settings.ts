import { ChatLastSettings, StoredChatSettings } from "@portikus/contracts";
import type { Database } from "@portikus/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { type Kysely, sql } from "kysely";
import { z } from "zod";
import { ProjectParam, parseOr400, sendError } from "../http.js";
import type { OwnedProject, OwnedScope } from "../workspaces/project-scope.js";

/** Codex's default mode: what a stored Full access falls to (SPEC.md §10.8). */
const CODEX_DEFAULT_MODE = "onRequest";
/** The Codex mode that switches its safety checks off, so it is never carried. */
const CODEX_FULL_ACCESS = "fullAccess";

/**
 * A stored value as a new chat reads it: Claude's Bypass permissions is
 * already Auto (the contract does it), and Codex's Full access is its
 * default mode.
 */
function carriedSettings(stored: unknown) {
	const settings = StoredChatSettings.parse(stored);
	const { codex } = settings;
	if (codex?.mode !== CODEX_FULL_ACCESS) return settings;
	return { ...settings, codex: { ...codex, mode: CODEX_DEFAULT_MODE } };
}

/** The read-aloud switch saved on its own, so it never rewrites the pickers. */
const ReadAloudOnly = z.object({ readAloud: z.boolean() }).strict();

/**
 * The chat picker values the owner last used in one project, which a new
 * chat there starts with (SPEC.md §10.8), and whether replies are read
 * aloud (ADR 0071). Only these values are kept, never anything from the
 * conversation (ADR 0012). Claude's values keep their flat keys and
 * Codex's sit under `codex`; a save changes the saving agent's values and
 * `agent`, which says which was used last (absent is Claude). A save
 * changes the keys it names and keeps the rest, in one statement, so the
 * pickers and the switch cannot overwrite each other.
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
		return carriedSettings(row.chat_settings);
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
			// Only the keys sent, and only the saving agent's: a Codex chat's
			// flat keys are Claude's, kept as they were.
			const { readAloud, ...pickers } = body.data;
			let changed: Record<string, unknown> =
				readAloud === undefined ? {} : { readAloud };
			let claudeLast = false;
			if ("model" in pickers) {
				if (pickers.agent === "codex") {
					if (pickers.codex === undefined) {
						return sendError(
							reply,
							400,
							"VALIDATION_FAILED",
							"A Codex chat saves its own model, effort and mode.",
						);
					}
					const { codex } = carriedSettings({ ...pickers, codex: pickers.codex });
					changed = { ...changed, agent: "codex", codex };
				} else {
					const { model, effort, mode } = carriedSettings(pickers);
					changed = { ...changed, model, effort, mode };
					claudeLast = true;
				}
			}
			// Left to right: the default, what is stored (Claude last-used means
			// no `agent`), then what was sent.
			const stored = claudeLast
				? sql`(coalesce(chat_settings, '{}'::jsonb) - 'agent')`
				: sql`coalesce(chat_settings, '{}'::jsonb)`;
			await db
				.updateTable("projects")
				.set({
					chat_settings: sql<string>`'{"readAloud": false}'::jsonb || ${stored} || ${JSON.stringify(changed)}::jsonb`,
				})
				.where("id", "=", row.id)
				.execute();
			return reply.status(204).send();
		},
	);
}
