import { basename } from "node:path";
import { Readable, Transform } from "node:stream";
import {
	contentDisposition,
	MAX_UPLOAD_BYTES,
	MkdirRequest,
	MoveRequest,
	ProjectPath,
	TreeResponse,
	WriteFileResponse,
} from "@portikus/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AGENT_TIMEOUT_MS, readAgentError, readJson } from "../agent-client.js";
import type { ServerDeps } from "../server.js";
import { agentUrl, scopedProject, sendAgentError, sendError } from "./project-scope.js";

/**
 * A budget for the agent's response headers alone. Once headers are back the
 * body may take as long as it likes, but a wedged agent must not hold a
 * control-plane connection open (SPEC.md §24.6).
 */
function headersDeadline() {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), AGENT_TIMEOUT_MS);
	return {
		signal: controller.signal,
		abort: () => controller.abort(),
		clear: () => clearTimeout(timer),
	};
}

/**
 * The content type the browser is given. Student content must never be
 * served as HTML on the control-plane origin, so the agent's own value is
 * never relayed: it is plain text or bytes, nothing else (SPEC.md §24.3).
 */
function pinnedType(value: string | null): string {
	const media = (value ?? "").split(";")[0]?.trim().toLowerCase();
	return media === "text/plain"
		? "text/plain; charset=utf-8"
		: "application/octet-stream";
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

/**
 * File routes (SPEC.md §11.1, §11.2, §13.5). The control plane brokers every
 * one of them: the browser never reaches the workspace agent, and the agent
 * is only called with the per-workspace token after the caller has been shown
 * to own the workspace and the project (SPEC.md §5.2, §24.6).
 */
export function registerFileRoutes(app: FastifyInstance, deps: ServerDeps): void {
	const { db, config } = deps;

	app.register(async (instance) => {
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
			const scope = await scopedProject(db, config, request, reply);
			if (!scope) return;
			const path = queryPath(request, reply, { allowRoot: true });
			if (path === null) return;

			let response: Response;
			try {
				response = await scope.agent.fetchRaw(
					"GET",
					agentUrl(scope.slug, "tree", { path }),
					{ signal: AbortSignal.timeout(AGENT_TIMEOUT_MS) },
				);
			} catch (error) {
				return sendAgentError(reply, error);
			}
			if (!response.ok) return relayFailure(reply, response);
			const parsed = TreeResponse.safeParse(await readJson(response));
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
			const scope = await scopedProject(db, config, request, reply);
			if (!scope) return;
			const path = queryPath(request, reply, { allowRoot: false });
			if (path === null) return;
			const download = (request.query as { download?: string }).download === "1";

			// One file streams straight through and races with nothing, so it
			// takes no long-operation slot; the zip download still does.
			const deadline = headersDeadline();
			let response: Response;
			try {
				response = await scope.agent.fetchRaw(
					"GET",
					agentUrl(scope.slug, "file", download ? { path, download: "1" } : { path }),
					{ signal: deadline.signal },
				);
			} catch (error) {
				return sendAgentError(reply, error);
			} finally {
				deadline.clear();
			}
			if (!response.ok) {
				return relayFailure(reply, response);
			}
			if (!response.body) {
				return sendError(
					reply,
					503,
					"AGENT_UNAVAILABLE",
					"The workspace agent sent no response body.",
				);
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
			reply.type(pinnedType(response.headers.get("content-type")));
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

			write.put("/workspaces/:id/projects/:pid/file", async (request, reply) => {
				const scope = await scopedProject(db, config, request, reply);
				if (!scope) return;
				const path = queryPath(request, reply, { allowRoot: false });
				if (path === null) return;

				const headers: Record<string, string> = {};
				for (const name of ["if-match", "if-none-match", "content-type"]) {
					const value = request.headers[name];
					if (typeof value === "string") headers[name] = value;
				}

				// The control plane counts the bytes itself, so the cap holds
				// whatever the agent does with the stream (SPEC.md §11.2).
				const deadline = headersDeadline();
				let sent = 0;
				let overCap = false;
				const counter = new Transform({
					transform(chunk: Buffer, _encoding, done) {
						sent += chunk.length;
						if (sent > MAX_UPLOAD_BYTES) {
							overCap = true;
							deadline.abort();
							done();
							return;
						}
						done(null, chunk);
					},
				});

				let response: Response;
				try {
					response = await scope.agent.fetchRaw(
						"PUT",
						agentUrl(scope.slug, "file", { path }),
						{
							headers,
							body: Readable.toWeb(
								request.raw.pipe(counter),
							) as ReadableStream<Uint8Array>,
							signal: deadline.signal,
						},
					);
				} catch (error) {
					if (overCap) return tooLarge(reply);
					return sendAgentError(reply, error);
				} finally {
					deadline.clear();
				}
				if (overCap) return tooLarge(reply);
				if (!response.ok) return relayFailure(reply, response);

				const parsed = WriteFileResponse.safeParse(await readJson(response));
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
			});
		});

		function tooLarge(reply: FastifyReply) {
			return sendError(
				reply,
				413,
				"FILE_TOO_LARGE",
				"That file is larger than the upload limit.",
			);
		}

		instance.delete("/workspaces/:id/projects/:pid/file", async (request, reply) => {
			const scope = await scopedProject(db, config, request, reply);
			if (!scope) return;
			const path = queryPath(request, reply, { allowRoot: false });
			if (path === null) return;

			let response: Response;
			try {
				response = await scope.agent.fetchRaw(
					"DELETE",
					agentUrl(scope.slug, "file", { path }),
					{ signal: AbortSignal.timeout(AGENT_TIMEOUT_MS) },
				);
			} catch (error) {
				return sendAgentError(reply, error);
			}
			if (!response.ok) return relayFailure(reply, response);
			// Nothing here reads the body, so give the connection back.
			await response.body?.cancel();
			return reply.status(204).send();
		});

		instance.post("/workspaces/:id/projects/:pid/mkdir", async (request, reply) => {
			const scope = await scopedProject(db, config, request, reply);
			if (!scope) return;
			const body = MkdirRequest.safeParse(request.body ?? {});
			if (!body.success) {
				return sendError(reply, 400, "VALIDATION_FAILED", "that path is not valid");
			}

			let response: Response;
			try {
				response = await scope.agent.fetchRaw("POST", agentUrl(scope.slug, "mkdir"), {
					headers: { "content-type": "application/json" },
					body: Buffer.from(JSON.stringify(body.data)),
					signal: AbortSignal.timeout(AGENT_TIMEOUT_MS),
				});
			} catch (error) {
				return sendAgentError(reply, error);
			}
			if (!response.ok) return relayFailure(reply, response);
			await response.body?.cancel();
			return reply.status(201).send({ ok: true });
		});

		instance.post("/workspaces/:id/projects/:pid/move", async (request, reply) => {
			const scope = await scopedProject(db, config, request, reply);
			if (!scope) return;
			const body = MoveRequest.safeParse(request.body ?? {});
			if (!body.success) {
				return sendError(reply, 400, "VALIDATION_FAILED", "that path is not valid");
			}

			let response: Response;
			try {
				response = await scope.agent.fetchRaw("POST", agentUrl(scope.slug, "move"), {
					headers: { "content-type": "application/json" },
					body: Buffer.from(JSON.stringify(body.data)),
					signal: AbortSignal.timeout(AGENT_TIMEOUT_MS),
				});
			} catch (error) {
				return sendAgentError(reply, error);
			}
			if (!response.ok) return relayFailure(reply, response);
			await response.body?.cancel();
			return reply.status(204).send();
		});
	});
}
