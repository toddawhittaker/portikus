import type { ApiConfig } from "@portikus/config";
import {
	type AgentProject,
	type CreateProjectRequest,
	slugify,
} from "@portikus/contracts";
import type { Database } from "@portikus/db";
import type { FastifyReply } from "fastify";
import type { Kysely } from "kysely";
import { AgentCallError, type AgentClient } from "../agent-client.js";
import { sendError } from "../http.js";
import { claimLongOperation, releaseLongOperation } from "./long-operation.js";
import {
	type ProjectRow,
	projectPath,
	requireAgent,
	type Scope,
	sendAgentError,
} from "./project-scope.js";

/** Why a project cannot be made where a folder already sits (SPEC.md §7.6). */
export function folderExistsMessage(slug: string): string {
	return `A folder named ${slug} is already in ~/projects, so a new project cannot be made there. Rename or remove that folder, then try again.`;
}

async function slugTaken(
	db: Kysely<Database>,
	workspaceId: string,
	slug: string,
): Promise<boolean> {
	const existing = await db
		.selectFrom("projects")
		.select("id")
		.where("workspace_id", "=", workspaceId)
		.where("slug", "=", slug)
		.executeTakeFirst();
	return existing !== undefined;
}

/** The agent's new project folder, or null after answering a refusal. */
async function createFolder(
	agent: AgentClient,
	workspaceId: string,
	reply: FastifyReply,
	request: Parameters<AgentClient["createProject"]>[0],
): Promise<AgentProject | null> {
	// An empty directory is quick; a clone or a template is not.
	const slow = request.source !== "new";
	if (slow && !claimLongOperation(workspaceId, reply)) return null;
	try {
		return await agent.createProject(request);
	} catch (error) {
		// No row but the agent refused: a folder of that name is already there.
		if (error instanceof AgentCallError && error.code === "PROJECT_EXISTS") {
			sendError(reply, 409, "PROJECT_EXISTS", folderExistsMessage(request.slug));
		} else {
			sendAgentError(reply, error);
		}
		return null;
	} finally {
		if (slow) releaseLongOperation(workspaceId);
	}
}

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

	if (await slugTaken(db, scope.workspaceId, slug)) {
		sendError(reply, 409, "PROJECT_EXISTS", `A project called ${slug} already exists.`);
		return null;
	}

	const created = await createFolder(agent, scope.workspaceId, reply, {
		slug,
		source: input.source,
		...(url === undefined ? {} : { url }),
		gitInit: input.gitInit,
	});
	if (!created) return null;

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
