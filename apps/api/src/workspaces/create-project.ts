import type { ApiConfig } from "@portikus/config";
import { type CreateProjectRequest, slugify } from "@portikus/contracts";
import type { Database } from "@portikus/db";
import type { FastifyReply } from "fastify";
import type { Kysely } from "kysely";
import { sendError } from "../http.js";
import { claimLongOperation, releaseLongOperation } from "./long-operation.js";
import {
	type ProjectRow,
	projectPath,
	requireAgent,
	type Scope,
	sendAgentError,
} from "./project-scope.js";

/**
 * Create a project's directory through the agent, then its row (SPEC.md
 * §7.2, §7.6). A slug some row already holds is refused with 409, and the
 * agent refuses a directory that is already there, so nothing is ever
 * overwritten. Null after answering a refusal.
 */
export async function createProject(
	db: Kysely<Database>,
	config: ApiConfig,
	scope: Scope,
	reply: FastifyReply,
	input: CreateProjectRequest,
): Promise<{ row: ProjectRow; isGitRepo: boolean } | null> {
	const agent = requireAgent(scope, reply);
	if (!agent) return null;

	const slug = slugify(input.name);
	if (slug === "") {
		sendError(
			reply,
			400,
			"INVALID_SLUG",
			"The project name must contain a letter or a digit.",
		);
		return null;
	}

	let url = input.url;
	if (input.source === "template") {
		const template = config.projectTemplates.find(
			(candidate) => candidate.name === input.template,
		);
		if (!template) {
			sendError(reply, 400, "VALIDATION_FAILED", "Unknown project template");
			return null;
		}
		url = template.url;
	}

	const existing = await db
		.selectFrom("projects")
		.select("id")
		.where("workspace_id", "=", scope.workspaceId)
		.where("slug", "=", slug)
		.executeTakeFirst();
	if (existing) {
		sendError(reply, 409, "PROJECT_EXISTS", `A project called ${slug} already exists.`);
		return null;
	}

	// An empty directory is quick; a clone or a template is not.
	const slow = input.source !== "new";
	if (slow && !claimLongOperation(scope.workspaceId, reply)) return null;

	let created: { isGitRepo: boolean; suggestedName?: string };
	try {
		created = await agent.createProject({
			slug,
			source: input.source,
			...(url === undefined ? {} : { url }),
			gitInit: input.gitInit,
		});
	} catch (error) {
		sendAgentError(reply, error);
		return null;
	} finally {
		if (slow) releaseLongOperation(scope.workspaceId);
	}

	const row = await db
		.insertInto("projects")
		.values({
			workspace_id: scope.workspaceId,
			slug,
			// The folder keeps the typed name's slug; only the display name
			// takes the one the repository gives itself.
			name:
				(input.nameFromRepository ? created.suggestedName : undefined) ?? input.name,
			path: projectPath(slug),
			source: input.source,
		})
		.returningAll()
		.executeTakeFirstOrThrow();
	return { row, isGitRepo: created.isGitRepo };
}
