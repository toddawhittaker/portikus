import { requireUser } from "@portikus/auth";
import type { ApiConfig } from "@portikus/config";
import type { ApiError, ApiErrorCode } from "@portikus/contracts";
import type { Database } from "@portikus/db";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Kysely, Selectable } from "kysely";
import { z } from "zod";
import { AgentCallError, type AgentClient, agentClientFor } from "../agent-client.js";
import { findWorkspaceOwnedBy } from "./workspace-view.js";

/** Where every project directory lives inside the workspace (SPEC.md §7.1). */
const PROJECTS_ROOT = "/home/student/projects";

export function projectPath(slug: string): string {
	return `${PROJECTS_ROOT}/${slug}`;
}

export type ProjectRow = Selectable<Database["projects"]>;

/** The agent path for one route of one project. */
export function agentUrl(
	slug: string,
	route: string,
	query: Record<string, string> = {},
) {
	const search = new URLSearchParams(query).toString();
	return `/projects/${encodeURIComponent(slug)}/${route}${search ? `?${search}` : ""}`;
}

const WorkspaceParam = z.object({ id: z.string().uuid() });
const ProjectParam = z.object({ id: z.string().uuid(), pid: z.string().uuid() });

export interface Scope {
	workspaceId: string;
	/** Whether the workspace itself is running, whatever the agent's state. */
	running: boolean;
	agent: AgentClient | null;
}

export function sendError(
	reply: FastifyReply,
	statusCode: number,
	code: ApiErrorCode,
	message: string,
): void {
	const body: ApiError = { code, message };
	reply.status(statusCode).send(body);
}

/** The status and code each agent error becomes (SPEC.md §27). */
export const AGENT_ERROR_STATUS: Partial<Record<string, [number, ApiErrorCode]>> = {
	PROJECT_EXISTS: [409, "PROJECT_EXISTS"],
	PROJECT_NOT_FOUND: [404, "PROJECT_NOT_FOUND"],
	INVALID_SLUG: [400, "INVALID_SLUG"],
	INVALID_URL: [400, "INVALID_URL"],
	GIT_FAILED: [400, "GIT_FAILED"],
	PATH_INVALID: [400, "PATH_INVALID"],
	FILE_NOT_FOUND: [404, "FILE_NOT_FOUND"],
	FILE_EXISTS: [409, "FILE_EXISTS"],
	FILE_CHANGED: [412, "FILE_CHANGED"],
	FILE_TOO_LARGE: [413, "FILE_TOO_LARGE"],
	NOT_A_DIRECTORY: [400, "NOT_A_DIRECTORY"],
	BAD_REQUEST: [400, "VALIDATION_FAILED"],
	CHECK_NOT_FOUND: [404, "CHECK_NOT_FOUND"],
	CHECK_RUNNING: [409, "CHECK_RUNNING"],
	CHECK_NOT_RUNNING: [404, "CHECK_NOT_RUNNING"],
	// Recovery points (SPEC.md §15, ADR 0020). There is no API code for a
	// refused archive, so it reads as a request that cannot be carried out.
	BUSY: [409, "BUSY"],
	STORAGE_FULL: [507, "STORAGE_FULL"],
	RECOVERY_POINT_INVALID: [422, "VALIDATION_FAILED"],
	RESTORE_INCOMPLETE: [500, "INTERNAL"],
	ROLLBACK_COPY_EXISTS: [409, "BUSY"],
	// The agent answers these with a 500 of its own, so the control plane is
	// reporting a failure upstream of it rather than one of its own.
	SEARCH_FAILED: [502, "SEARCH_FAILED"],
	WATCH_FAILED: [502, "WATCH_FAILED"],
};

/** A student-facing message that replaces the agent's own, by agent code. */
const AGENT_ERROR_MESSAGE: Partial<Record<string, string>> = {
	RESTORE_INCOMPLETE:
		"The project may be partly restored. Restore the 'Before restore' point to undo.",
};

/** Report an agent failure to the browser; anything else is a real error. */
export function sendAgentError(reply: FastifyReply, error: unknown): void {
	if (!(error instanceof AgentCallError)) throw error;
	const mapped = AGENT_ERROR_STATUS[error.code];
	if (mapped) {
		sendError(
			reply,
			mapped[0],
			mapped[1],
			AGENT_ERROR_MESSAGE[error.code] ?? error.message,
		);
		return;
	}
	sendError(
		reply,
		503,
		"AGENT_UNAVAILABLE",
		"The workspace agent could not be reached.",
	);
}

/**
 * Workspaces with a long project operation (clone, template, duplicate,
 * download) running right now. Clone and copy hold a request open for
 * minutes, and two at once on one workspace race over the same directories.
 * This is per API process; the pilot runs exactly one (ADR 0010).
 */
const longOperations = new Set<string>();

/**
 * Claim the one long-operation slot for a workspace. Returns false after
 * answering 409, so the caller just returns.
 */
export function claimLongOperation(workspaceId: string, reply: FastifyReply): boolean {
	if (longOperations.has(workspaceId)) {
		sendError(
			reply,
			409,
			"OPERATION_IN_PROGRESS",
			"Another project operation is already running on this workspace.",
		);
		return false;
	}
	longOperations.add(workspaceId);
	return true;
}

/** Whether the workspace's long-operation slot is held right now. */
export function longOperationRunning(workspaceId: string): boolean {
	return longOperations.has(workspaceId);
}

/** Give the long-operation slot back. */
export function releaseLongOperation(workspaceId: string): void {
	longOperations.delete(workspaceId);
}

/**
 * Load the workspace for its owner, plus an agent client when the workspace
 * is running. Returns null after answering, so callers just return. This is
 * the one ownership check every project and file route goes through: an
 * administrator is not an owner and gets the same 404 (SPEC.md §5.2, §24.6).
 */
export async function ownedScope(
	db: Kysely<Database>,
	config: ApiConfig,
	request: FastifyRequest,
	reply: FastifyReply,
): Promise<Scope | null> {
	const user = requireUser(request);
	const params = WorkspaceParam.safeParse(request.params);
	if (!params.success) {
		sendError(reply, 400, "VALIDATION_FAILED", params.error.message);
		return null;
	}
	const workspace = await findWorkspaceOwnedBy(db, params.data.id, user.id);
	if (!workspace) {
		sendError(reply, 404, "WORKSPACE_NOT_FOUND", "Workspace not found");
		return null;
	}
	const running = workspace.state === "running";
	const agent = agentClientFor(workspace, config.AGENT_PORT);
	return {
		workspaceId: params.data.id,
		running,
		agent: running ? agent : null,
	};
}

/**
 * The agent for an operation that needs one, or null after answering. A
 * stopped workspace is the student's problem to fix; a running workspace
 * with no reachable agent is ours.
 */
export function requireAgent(scope: Scope, reply: FastifyReply): AgentClient | null {
	if (scope.agent) return scope.agent;
	if (scope.running) {
		sendError(reply, 503, "AGENT_UNAVAILABLE", "The workspace agent is not reachable.");
		return null;
	}
	sendError(
		reply,
		409,
		"AGENT_UNAVAILABLE",
		"The workspace is not running yet. Start it and try again.",
	);
	return null;
}

/** The project row of this workspace, or null after answering 404. */
export async function ownedProject(
	db: Kysely<Database>,
	workspaceId: string,
	projectId: string,
	reply: FastifyReply,
): Promise<ProjectRow | null> {
	const row = await db
		.selectFrom("projects")
		.selectAll()
		.where("id", "=", projectId)
		.where("workspace_id", "=", workspaceId)
		.executeTakeFirst();
	if (!row) {
		sendError(reply, 404, "PROJECT_NOT_FOUND", "Project not found");
		return null;
	}
	return row;
}

/** The project and agent one brokered project route works against. */
export interface ProjectScope {
	agent: AgentClient;
	slug: string;
	workspaceId: string;
}

/**
 * The single ownership gate every brokered project route goes through: the
 * workspace for its owner, the project inside it and the agent, or null
 * after answering (SPEC.md §5.2, §24.6).
 */
export async function scopedProject(
	db: Kysely<Database>,
	config: ApiConfig,
	request: FastifyRequest,
	reply: FastifyReply,
): Promise<ProjectScope | null> {
	const params = ProjectParam.safeParse(request.params);
	if (!params.success) {
		sendError(reply, 400, "VALIDATION_FAILED", params.error.message);
		return null;
	}
	const scope = await ownedScope(db, config, request, reply);
	if (!scope) return null;
	const row = await ownedProject(db, scope.workspaceId, params.data.pid, reply);
	if (!row) return null;
	const agent = requireAgent(scope, reply);
	if (!agent) return null;
	return { agent, slug: row.slug, workspaceId: scope.workspaceId };
}
