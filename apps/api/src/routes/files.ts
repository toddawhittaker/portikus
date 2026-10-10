import { Readable, Transform } from "node:stream";
import {
	ExtractProgress,
	ExtractRequest,
	ExtractResponse,
	MAX_UPLOAD_BYTES,
	MkdirRequest,
	MoveRequest,
	TreeResponse,
	WriteFileResponse,
} from "@portikus/contracts";
import type { FastifyInstance, FastifyReply } from "fastify";
import { recordActivity } from "../activity.js";
import {
	AGENT_EXTRACT_TIMEOUT_MS,
	AGENT_TIMEOUT_MS,
	readAgentError,
	readJson,
} from "../agent-client.js";
import type { ServerDeps } from "../deps.js";
import { sendError } from "../http.js";
import type { UserLimit } from "../rate-limit.js";
import {
	headersDeadline,
	inlineType,
	queryPath,
	sendFile,
	treeQuery,
} from "../workspaces/file-relay.js";
import {
	claimLongOperation,
	releaseLongOperation,
} from "../workspaces/long-operation.js";
import {
	agentUrl,
	scopedProject,
	sendAgentError,
} from "../workspaces/project-scope.js";

// The request headers a conditional write passes on to the agent.
function writeHeaders(incoming: Record<string, string | string[] | undefined>) {
	const headers: Record<string, string> = {};
	for (const name of ["if-match", "if-none-match", "content-type"]) {
		const value = incoming[name];
		if (typeof value === "string") headers[name] = value;
	}
	return headers;
}

/**
 * File routes (SPEC.md §11.1, §11.2, §13.5). The control plane brokers every
 * one of them: the browser never reaches the workspace agent, and the agent
 * is only called with the per-workspace token after the caller has been shown
 * to own the workspace and the project (SPEC.md §5.2, §24.6).
 */
export function registerFileRoutes(
	app: FastifyInstance,
	deps: ServerDeps,
	limitWrites: UserLimit,
): void {
	const { db, config } = deps;

	app.register(async (instance) => {
		// Every file route but a read counts against the user's write limit.
		instance.addHook("preHandler", async (request, reply) => {
			if (request.method === "GET" || request.method === "HEAD") return;
			if (!(await limitWrites(request, reply))) return reply;
		});

		/** Turn an unsuccessful agent response into the browser's error. */
		async function relayFailure(reply: FastifyReply, response: Response) {
			const error = await readAgentError(response);
			// A stale write needs the current etag so the editor can recover
			// (SPEC.md §13.5).
			const etag = response.headers.get("etag");
			if (etag) reply.header("etag", etag);
			return sendAgentError(reply, error);
		}

		// One directory listing, straight from the agent.
		instance.get("/workspaces/:id/projects/:pid/tree", async (request, reply) => {
			const scope = await scopedProject(db, config, request, reply);
			if (!scope) return;
			const query = treeQuery(request, reply);
			if (query === null) return;

			let response: Response;
			try {
				response = await scope.agent.fetchRaw(
					"GET",
					agentUrl(scope.slug, "tree", query),
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

		// Streamed, so a download of any size never sits in memory.
		instance.get("/workspaces/:id/projects/:pid/file", async (request, reply) => {
			const scope = await scopedProject(db, config, request, reply);
			if (!scope) return;
			const path = queryPath(request, reply, { allowRoot: false });
			if (path === null) return;
			const query = request.query as { download?: string; inline?: string };
			const download = query.download === "1";
			// The viewer's mode: the real type of an image or PDF, never a guess.
			const wantsInline = !download && query.inline === "1";
			const inline = wantsInline ? inlineType(path) : null;
			if (wantsInline && inline === null) {
				return sendError(
					reply,
					415,
					"VALIDATION_FAILED",
					"Only images and PDF files can be shown here. Download the file to open it.",
				);
			}

			// One file streams straight through and races with nothing, so it
			// takes no long-operation slot; the zip download still does.
			const deadline = headersDeadline();
			let response: Response;
			try {
				response = await scope.agent.fetchRaw(
					"GET",
					// An inline file streams like a download, so a large PDF is not
					// held to the editor's 2 MiB cap.
					agentUrl(
						scope.slug,
						"file",
						download || inline ? { path, download: "1" } : { path },
					),
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

			return sendFile(reply, response, response.body, path, download, inline);
		});

		// A conditional write, streamed through (SPEC.md §13.5). It
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
				// A write by the owner is activity; reads are not (ADR 0032).
				await recordActivity(db, scope.workspaceId);
				const path = queryPath(request, reply, { allowRoot: false });
				if (path === null) return;

				const headers = writeHeaders(request.headers);

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
				// The next save is conditional on this etag too.
				reply.header("cache-control", "no-transform");
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
			// A write by the owner is activity; reads are not (ADR 0032).
			await recordActivity(db, scope.workspaceId);
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
			// A write by the owner is activity; reads are not (ADR 0032).
			await recordActivity(db, scope.workspaceId);
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

		// jscpd:ignore-start -- each route spells out its own checks, in order.
		instance.post("/workspaces/:id/projects/:pid/move", async (request, reply) => {
			const scope = await scopedProject(db, config, request, reply);
			if (!scope) return;
			// A write by the owner is activity; reads are not (ADR 0032).
			await recordActivity(db, scope.workspaceId);
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
		// jscpd:ignore-end

		// "Extract here" on a zip. One at a time
		// per workspace, because a large zip holds the request for minutes.
		instance.post("/workspaces/:id/projects/:pid/extract", async (request, reply) => {
			const scope = await scopedProject(db, config, request, reply);
			if (!scope) return;
			await recordActivity(db, scope.workspaceId);
			const body = ExtractRequest.safeParse(request.body ?? {});
			if (!body.success) {
				return sendError(reply, 400, "VALIDATION_FAILED", "that path is not valid");
			}
			if (!claimLongOperation(scope.workspaceId, reply)) return;
			try {
				let response: Response;
				try {
					response = await scope.agent.fetchRaw(
						"POST",
						agentUrl(scope.slug, "extract"),
						{
							headers: { "content-type": "application/json" },
							body: Buffer.from(JSON.stringify(body.data)),
							signal: AbortSignal.timeout(AGENT_EXTRACT_TIMEOUT_MS),
						},
					);
				} catch (error) {
					return sendAgentError(reply, error);
				}
				if (!response.ok) return relayFailure(reply, response);
				const parsed = ExtractResponse.safeParse(await readJson(response));
				if (!parsed.success) {
					return sendError(
						reply,
						503,
						"AGENT_UNAVAILABLE",
						"The workspace agent sent an answer we could not read.",
					);
				}
				return reply.status(201).send(parsed.data);
			} finally {
				releaseLongOperation(scope.workspaceId);
			}
		});

		// How far a running "Extract here" has got, polled by the browser while
		// the extract request is still open. Only counts cross, never names.
		instance.get(
			"/workspaces/:id/projects/:pid/extract/progress",
			async (request, reply) => {
				const scope = await scopedProject(db, config, request, reply);
				if (!scope) return;
				let response: Response;
				try {
					response = await scope.agent.fetchRaw(
						"GET",
						agentUrl(scope.slug, "extract/progress"),
						{ signal: AbortSignal.timeout(AGENT_TIMEOUT_MS) },
					);
				} catch (error) {
					return sendAgentError(reply, error);
				}
				if (!response.ok) return relayFailure(reply, response);
				const parsed = ExtractProgress.safeParse(await readJson(response));
				if (!parsed.success) {
					return sendError(
						reply,
						503,
						"AGENT_UNAVAILABLE",
						"The workspace agent sent an answer we could not read.",
					);
				}
				return parsed.data;
			},
		);
	});
}
