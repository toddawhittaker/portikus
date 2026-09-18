import { basename } from "node:path";
import { Readable } from "node:stream";
import {
	MAX_UPLOAD_BYTES,
	MkdirRequest,
	MoveRequest,
	ProjectPath,
	TreeResponse,
	WriteFileResponse,
} from "@portikus/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { type AgentClient, readAgentError, readAgentJson } from "../agent-client.js";
import type { ServerDeps } from "../server.js";
import {
	contentDisposition,
	ownedProject,
	ownedScope,
	requireAgent,
	sendAgentError,
	sendError,
} from "./project-scope.js";

const ProjectParam = z.object({ id: z.string().uuid(), pid: z.string().uuid() });

/** A small file operation is a local HTTP call and should be quick. */
const AGENT_TIMEOUT_MS = 5000;

/** What a route needs once the caller has been shown to own the project. */
interface FileScope {
	agent: AgentClient;
	slug: string;
}

/**
 * The project-relative path from the query. Every path is checked here as
 * well as in the agent, so a traversal attempt never leaves the control
 * plane (SPEC.md §11.1, §24.6). The tree of the project root is the one
 * empty path the API accepts.
 */
function queryPath(
	request: FastifyRequest,
	reply: FastifyReply,
	options: { allowRoot: boolean },
): string | null {
	const query = (request.query ?? {}) as { path?: unknown };
	const raw = query.path === undefined ? "" : query.path;
	if (typeof raw !== "string") {
		sendError(reply, 400, "VALIDATION_FAILED", "path must be a string");
		return null;
	}
	if (raw === "") {
		if (options.allowRoot) return "";
		sendError(reply, 400, "VALIDATION_FAILED", "path is required");
		return null;
	}
	const parsed = ProjectPath.safeParse(raw);
	if (!parsed.success) {
		sendError(reply, 400, "VALIDATION_FAILED", "that path is not inside the project");
		return null;
	}
	return parsed.data;
}

/** The agent path for one file route of one project. */
function agentUrl(slug: string, route: string, query: Record<string, string> = {}) {
	const search = new URLSearchParams(query).toString();
	return `/projects/${encodeURIComponent(slug)}/${route}${search ? `?${search}` : ""}`;
}

/**
 * File routes (SPEC.md §11.1, §11.2, §13.5). The control plane brokers every
 * one of them: the browser never reaches the workspace agent, and the agent
 * is only called with the per-workspace token after the caller has been shown
 * to own the workspace and the project (SPEC.md §5.2, §24.6).
 */
export function registerFileRoutes(app: FastifyInstance, deps: ServerDeps): void {
	const { db, config } = deps;

	app.register(async (instance) => {
		/**
		 * Resolve the workspace, the project and the agent, or answer and return
		 * null. This is the single ownership gate for every route below.
		 */
		async function scoped(
			request: FastifyRequest,
			reply: FastifyReply,
		): Promise<FileScope | null> {
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
			return { agent, slug: row.slug };
		}

		/** Turn an unsuccessful agent response into the browser's error. */
		async function relayFailure(reply: FastifyReply, response: Response) {
			const error = await readAgentError(response);
			// A stale write needs the current etag so the editor can recover
			// (SPEC.md §13.5).
			const etag = response.headers.get("etag");
			if (etag) reply.header("etag", etag);
			return sendAgentError(reply, error);
		}

		// GET tree -- one directory listing, straight from the agent.
		instance.get("/workspaces/:id/projects/:pid/tree", async (request, reply) => {
			const scope = await scoped(request, reply);
			if (!scope) return;
			const path = queryPath(request, reply, { allowRoot: true });
			if (path === null) return;

			const response = await scope.agent.fetchRaw(
				"GET",
				agentUrl(scope.slug, "tree", { path }),
				{ signal: AbortSignal.timeout(AGENT_TIMEOUT_MS) },
			);
			if (!response.ok) return relayFailure(reply, response);
			const parsed = TreeResponse.safeParse(await readAgentJson(response));
			if (!parsed.success) {
				return sendError(
					reply,
					503,
					"AGENT_UNAVAILABLE",
					"The workspace agent sent a listing we could not read.",
				);
			}
			return parsed.data;
		});

		// GET file -- streamed, so a download of any size never sits in memory.
		instance.get("/workspaces/:id/projects/:pid/file", async (request, reply) => {
			const scope = await scoped(request, reply);
			if (!scope) return;
			const path = queryPath(request, reply, { allowRoot: false });
			if (path === null) return;
			const download = (request.query as { download?: string }).download === "1";

			const response = await scope.agent.fetchRaw(
				"GET",
				agentUrl(scope.slug, "file", download ? { path, download: "1" } : { path }),
			);
			if (!response.ok) return relayFailure(reply, response);
			if (!response.body) {
				return sendError(reply, 503, "AGENT_UNAVAILABLE", "The file was empty.");
			}

			const etag = response.headers.get("etag");
			if (etag) reply.header("etag", etag);
			const length = response.headers.get("content-length");
			if (length) reply.header("content-length", length);
			if (download) {
				// The name comes from the path the student asked for, quoted and
				// escaped here rather than anywhere near a shell.
				reply.header("content-disposition", contentDisposition(basename(path)));
			}
			reply.type(response.headers.get("content-type") ?? "application/octet-stream");
			return reply.send(Readable.fromWeb(response.body as never));
		});

		// PUT file -- a conditional write, streamed through (SPEC.md §13.5). It
		// sits in its own plugin because it is the one route that must see the
		// raw body: Fastify parses JSON and text/plain by itself, and every
		// other route here still wants that.
		instance.register(async (write) => {
			write.removeAllContentTypeParsers();
			write.addContentTypeParser("*", (_request, payload, done) => {
				done(null, payload);
			});

			write.put(
				"/workspaces/:id/projects/:pid/file",
				// Uploads are the largest body this route accepts; the agent
				// applies the smaller editor cap itself (SPEC.md §11.2, §13.5).
				{ bodyLimit: MAX_UPLOAD_BYTES },
				async (request, reply) => {
					const scope = await scoped(request, reply);
					if (!scope) return;
					const path = queryPath(request, reply, { allowRoot: false });
					if (path === null) return;

					const headers: Record<string, string> = {};
					for (const name of ["if-match", "if-none-match", "content-type"]) {
						const value = request.headers[name];
						if (typeof value === "string") headers[name] = value;
					}

					const body = request.body as Readable | undefined;
					const response = await scope.agent.fetchRaw(
						"PUT",
						agentUrl(scope.slug, "file", { path }),
						{
							headers,
							body: body
								? (Readable.toWeb(body) as ReadableStream<Uint8Array>)
								: Buffer.alloc(0),
						},
					);
					if (!response.ok) return relayFailure(reply, response);

					const parsed = WriteFileResponse.safeParse(await readAgentJson(response));
					if (!parsed.success) {
						return sendError(
							reply,
							503,
							"AGENT_UNAVAILABLE",
							"The workspace agent did not confirm the write.",
						);
					}
					reply.header("etag", parsed.data.etag);
					return parsed.data;
				},
			);
		});

		instance.delete("/workspaces/:id/projects/:pid/file", async (request, reply) => {
			const scope = await scoped(request, reply);
			if (!scope) return;
			const path = queryPath(request, reply, { allowRoot: false });
			if (path === null) return;

			const response = await scope.agent.fetchRaw(
				"DELETE",
				agentUrl(scope.slug, "file", { path }),
				{ signal: AbortSignal.timeout(AGENT_TIMEOUT_MS) },
			);
			if (!response.ok) return relayFailure(reply, response);
			return reply.status(204).send();
		});

		instance.post("/workspaces/:id/projects/:pid/mkdir", async (request, reply) => {
			const scope = await scoped(request, reply);
			if (!scope) return;
			const body = MkdirRequest.safeParse(request.body ?? {});
			if (!body.success) {
				return sendError(reply, 400, "VALIDATION_FAILED", "that path is not valid");
			}

			const response = await scope.agent.fetchRaw(
				"POST",
				agentUrl(scope.slug, "mkdir"),
				{
					headers: { "content-type": "application/json" },
					body: Buffer.from(JSON.stringify(body.data)),
					signal: AbortSignal.timeout(AGENT_TIMEOUT_MS),
				},
			);
			if (!response.ok) return relayFailure(reply, response);
			return reply.status(201).send({ ok: true });
		});

		instance.post("/workspaces/:id/projects/:pid/move", async (request, reply) => {
			const scope = await scoped(request, reply);
			if (!scope) return;
			const body = MoveRequest.safeParse(request.body ?? {});
			if (!body.success) {
				return sendError(reply, 400, "VALIDATION_FAILED", "that path is not valid");
			}

			const response = await scope.agent.fetchRaw(
				"POST",
				agentUrl(scope.slug, "move"),
				{
					headers: { "content-type": "application/json" },
					body: Buffer.from(JSON.stringify(body.data)),
					signal: AbortSignal.timeout(AGENT_TIMEOUT_MS),
				},
			);
			if (!response.ok) return relayFailure(reply, response);
			return reply.status(204).send();
		});
	});
}
