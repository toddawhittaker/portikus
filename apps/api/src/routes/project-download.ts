import { basename } from "node:path";
import {
	contentDisposition,
	MAX_DOWNLOAD_PATHS,
	ProjectPath,
} from "@portikus/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
	AGENT_DOWNLOAD_HEADERS_TIMEOUT_MS,
	type AgentClient,
	archiveQuery,
	readAgentError,
} from "../agent-client.js";
import { ProjectParam, parseOr400, sendError } from "../http.js";
import { cappedDownload } from "../workspaces/capped-download.js";
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

/** The project's zip download and its size check (SPEC.md §11.2). */
export function registerProjectDownloadRoute(
	app: FastifyInstance,
	owned: (request: FastifyRequest, reply: FastifyReply) => Promise<Scope | null>,
	ownedProject: (
		workspaceId: string,
		projectId: string,
		reply: FastifyReply,
	) => Promise<ProjectRow | null>,
): void {
	/** Answers 204 when the download would be under the size cap. */
	async function checkDownloadSize(
		agent: AgentClient,
		slug: string,
		subPaths: readonly string[],
		reply: FastifyReply,
	) {
		let checked: Response;
		try {
			checked = await agent.fetchRaw(
				"GET",
				`/projects/${encodeURIComponent(slug)}/archive${archiveQuery(subPaths, true)}`,
				{ signal: AbortSignal.timeout(AGENT_DOWNLOAD_HEADERS_TIMEOUT_MS) },
			);
		} catch (error) {
			return sendAgentError(reply, error);
		}
		if (!checked.ok) return sendAgentError(reply, await readAgentError(checked));
		await checked.body?.cancel();
		return reply.status(204).send();
	}

	// The agent's zip, streamed.
	// With `?path=` it is one directory inside the project; a repeated `path`
	// is a selection of files and folders (SPEC.md §11.2).
	app.get("/workspaces/:id/projects/:pid/download", async (request, reply) => {
		const params = parseOr400(ProjectParam, request.params, reply);
		if (!params) return;
		const scope = await owned(request, reply);
		if (!scope) return;
		const row = await ownedProject(scope.workspaceId, params.pid, reply);
		if (!row) return;
		const agent = requireAgent(scope, reply);
		if (!agent) return;

		// The path is checked here as well as in the agent, so a traversal
		// attempt never leaves the control plane (SPEC.md §11.1, §24.6).
		const subPaths = downloadPaths((request.query as { path?: unknown }).path);
		if (subPaths === "too-many") {
			return sendError(
				reply,
				400,
				"VALIDATION_FAILED",
				`a download can name at most ${MAX_DOWNLOAD_PATHS} paths`,
			);
		}
		if (subPaths === null) {
			return sendError(
				reply,
				400,
				"VALIDATION_FAILED",
				"that path is not inside the project",
			);
		}

		// `check=1` asks only whether the download is under the size cap, so
		// the browser can explain a refusal before it starts a download.
		if ((request.query as { check?: unknown }).check === "1") {
			return checkDownloadSize(agent, row.slug, subPaths, reply);
		}

		// Zipping runs while the response streams, so the slot is held until the
		// response is done, not just until the headers come back.
		if (!claimLongOperation(scope.workspaceId, reply)) return;
		const release = () => releaseLongOperation(scope.workspaceId);

		// A browser that gives up must not leave the agent zipping.
		const cancel = new AbortController();
		reply.raw.once("close", () => cancel.abort());
		let upstream: Response;
		try {
			upstream = await agent.downloadProject(row.slug, subPaths, cancel.signal);
		} catch (error) {
			release();
			return sendAgentError(reply, error);
		}
		if (!upstream.body) {
			release();
			return sendError(reply, 503, "AGENT_UNAVAILABLE", "The archive was empty.");
		}

		const stream = cappedDownload(upstream.body);
		stream.on("close", release);
		stream.on("error", release);

		// The name is the slug, or the one directory that was asked for; either
		// way it is escaped rather than sent through as typed.
		const name = subPaths.length === 1 ? basename(subPaths[0] as string) : row.slug;
		reply.header("content-type", "application/zip");
		reply.header("content-disposition", contentDisposition(`${name}.zip`));
		return reply.send(stream);
	});
}

/**
 * The download's `path` query: absent or "" is the whole project, one value
 * a directory, a repeated one a selection. Each must be a project path.
 */
function downloadPaths(asked: unknown): string[] | null | "too-many" {
	const values = Array.isArray(asked) ? asked : asked === undefined ? [] : [asked];
	if (values.length > MAX_DOWNLOAD_PATHS) return "too-many";
	if (values.length === 1 && values[0] === "") return [];
	const paths: string[] = [];
	for (const value of values) {
		const parsed = ProjectPath.safeParse(value);
		if (!parsed.success) return null;
		paths.push(parsed.data);
	}
	return paths;
}
