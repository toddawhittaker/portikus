import { requireUser } from "@portikus/auth";
import {
	type CourseSharesResponse,
	ProjectPath,
	SharedChecksResponse,
	SharedGitDiffResponse,
	SharedGitStatusResponse,
	SharedTreeResponse,
	WorkspaceState,
} from "@portikus/contracts";
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { z } from "zod";
import { AGENT_TIMEOUT_MS, readAgentError } from "../agent-client.js";
import { teachesCourse } from "../courses/membership.js";
import type { ServerDeps } from "../deps.js";
import { sendError } from "../http.js";
import {
	GIT_DIFF_BUDGET_MS,
	GIT_STATUS_BUDGET_MS,
	relayJson,
} from "../workspaces/agent-relay.js";
import {
	headersDeadline,
	inlineType,
	queryPath,
	sendFile,
	treeQuery,
} from "../workspaces/file-relay.js";
import { agentUrl, sendAgentError } from "../workspaces/project-scope.js";
import {
	filterGitStatus,
	filterTree,
	isSecretPath,
} from "../workspaces/secret-paths.js";
import { sharedProject } from "../workspaces/shared-scope.js";

const CourseParam = z.object({ courseId: z.string().uuid() });

/** A secret path answers as a missing file, so the name gives nothing away. */
const HIDDEN_MESSAGE = "no such file or directory";

/**
 * An instructor's read-only view of projects their students shared
 * (SPEC.md §5.2, ADR 0057). Only the reads listed here exist: no search,
 * download, terminal, preview or write ever reaches a shared project. Every
 * answer is `no-store`, so a page cached by the browser outlives no share.
 */
export function registerCourseShareRoutes(
	app: FastifyInstance,
	deps: ServerDeps,
): void {
	const { db, config } = deps;

	app.register(async (instance) => {
		// Synchronous, like every onSend hook here: see registerRequestLogging.
		instance.addHook("onSend", (_request, reply, payload, done) => {
			reply.header("cache-control", "no-store");
			done(null, payload);
		});

		instance.get("/courses/:courseId/shares", async (request, reply) => {
			const user = requireUser(request);
			const params = CourseParam.safeParse(request.params);
			if (!params.success) return sendError(reply, 404, "NOT_FOUND", "Not found.");
			const { courseId } = params.data;
			if (!(await teachesCourse(db, { userId: user.id, courseId }))) {
				return sendError(reply, 404, "NOT_FOUND", "Not found.");
			}
			const rows = await db
				.selectFrom("project_shares")
				.innerJoin("projects", "projects.id", "project_shares.project_id")
				.innerJoin("workspaces", "workspaces.id", "projects.workspace_id")
				.innerJoin("users", "users.id", "workspaces.owner_user_id")
				.innerJoin("lti_memberships", "lti_memberships.user_id", "users.id")
				.select([
					"projects.id as project_id",
					"projects.name",
					"users.id as user_id",
					"users.display_name",
					"project_shares.started_at",
					"project_shares.ends_at",
					"workspaces.state",
				])
				.where("lti_memberships.context_id", "=", courseId)
				.where("project_shares.ended_at", "is", null)
				.where("project_shares.ends_at", ">", sql<Date>`now()`)
				.where("projects.state", "=", "active")
				.orderBy("users.display_name")
				.orderBy("projects.name")
				.execute();
			const body: CourseSharesResponse = {
				shares: rows.map((row) => ({
					projectId: row.project_id,
					projectName: row.name,
					userId: row.user_id,
					displayName: row.display_name,
					startedAt: new Date(row.started_at).toISOString(),
					endsAt: new Date(row.ends_at).toISOString(),
					workspaceState: WorkspaceState.parse(row.state),
				})),
			};
			return body;
		});

		instance.get(
			"/courses/:courseId/shares/:projectId/tree",
			async (request, reply) => {
				const scope = await sharedProject(db, config, request, reply);
				if (!scope) return;
				const query = treeQuery(request, reply);
				if (query === null) return;
				if (isSecretPath(query.path)) {
					return sendError(reply, 404, "FILE_NOT_FOUND", HIDDEN_MESSAGE);
				}
				const tree = await relayJson(
					reply,
					request.log,
					scope.agent,
					agentUrl(scope.slug, "tree", query),
					SharedTreeResponse,
					AbortSignal.timeout(AGENT_TIMEOUT_MS),
				);
				return tree && filterTree(query.path, tree);
			},
		);

		// Text and images only: never a download (ADR 0057).
		instance.get(
			"/courses/:courseId/shares/:projectId/file",
			async (request, reply) => {
				const scope = await sharedProject(db, config, request, reply);
				if (!scope) return;
				const path = queryPath(request, reply, { allowRoot: false });
				if (path === null) return;
				const wantsInline = (request.query as { inline?: string }).inline === "1";
				const inline = wantsInline ? inlineType(path) : null;
				if (wantsInline && inline === null) {
					return sendError(
						reply,
						415,
						"VALIDATION_FAILED",
						"Only images and PDF files can be shown here.",
					);
				}
				if (isSecretPath(path)) {
					return sendError(reply, 404, "FILE_NOT_FOUND", HIDDEN_MESSAGE);
				}

				const deadline = headersDeadline();
				let response: Response;
				try {
					response = await scope.agent.fetchRaw(
						"GET",
						// An inline file streams like a download, as the owner's viewer does.
						agentUrl(scope.slug, "file", inline ? { path, download: "1" } : { path }),
						{ signal: deadline.signal },
					);
				} catch (error) {
					return sendAgentError(reply, error);
				} finally {
					deadline.clear();
				}
				if (!response.ok) return sendAgentError(reply, await readAgentError(response));
				if (!response.body) {
					return sendError(
						reply,
						503,
						"AGENT_UNAVAILABLE",
						"The workspace agent sent no response body.",
					);
				}
				return sendFile(reply, response, response.body, path, false, inline);
			},
		);

		instance.get(
			"/courses/:courseId/shares/:projectId/git/status",
			async (request, reply) => {
				const scope = await sharedProject(db, config, request, reply);
				if (!scope) return;
				const status = await relayJson(
					reply,
					request.log,
					scope.agent,
					agentUrl(scope.slug, "git/status", { hidden: "false" }),
					SharedGitStatusResponse,
					AbortSignal.timeout(GIT_STATUS_BUDGET_MS),
				);
				return status && filterGitStatus(status);
			},
		);

		// HEAD against the working tree only; no ref (ADR 0057).
		instance.get(
			"/courses/:courseId/shares/:projectId/git/diff",
			async (request, reply) => {
				const scope = await sharedProject(db, config, request, reply);
				if (!scope) return;
				const path = ProjectPath.safeParse((request.query as { path?: unknown }).path);
				if (!path.success) {
					return sendError(
						reply,
						400,
						"VALIDATION_FAILED",
						"that path is not inside the project",
					);
				}
				if (isSecretPath(path.data)) {
					return sendError(reply, 404, "FILE_NOT_FOUND", HIDDEN_MESSAGE);
				}
				const diff = await relayJson(
					reply,
					request.log,
					scope.agent,
					agentUrl(scope.slug, "git/diff", { path: path.data }),
					SharedGitDiffResponse,
					AbortSignal.timeout(GIT_DIFF_BUDGET_MS),
				);
				if (!diff) return;
				// A rename from a secret would show the secret's old content.
				if (diff.oldPath !== undefined && isSecretPath(diff.oldPath)) {
					return sendError(reply, 404, "FILE_NOT_FOUND", HIDDEN_MESSAGE);
				}
				return diff;
			},
		);

		instance.get(
			"/courses/:courseId/shares/:projectId/checks",
			async (request, reply) => {
				const scope = await sharedProject(db, config, request, reply);
				if (!scope) return;
				return relayJson(
					reply,
					request.log,
					scope.agent,
					agentUrl(scope.slug, "checks"),
					SharedChecksResponse,
					AbortSignal.timeout(AGENT_TIMEOUT_MS),
				);
			},
		);
	});
}
