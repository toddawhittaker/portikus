import { basename } from "node:path";
import type { Readable } from "node:stream";
import {
	contentDisposition,
	ExtractRequest,
	MAX_DOWNLOAD_PATHS,
	MkdirRequest,
	MoveRequest,
	NO_LINKS_QUERY,
	TreeAfter,
} from "@portikus/contracts";
import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { readChatImage } from "./chat-image.js";
import { AgentFailure, abortOnDisconnect, sendError } from "./errors.js";
import { extractProgress, extractZip } from "./extract.js";
import {
	listDir,
	mkdir,
	move,
	readFile,
	remove,
	resolveInProject,
	writeFile,
} from "./files.js";
import {
	excludeOnPortikusWrite,
	PASTES_DIR,
	removeOldPastes,
} from "./project-files.js";
import {
	archiveDir,
	archiveProject,
	archiveSelection,
	checkDownloadSize,
	outermostPaths,
	resolveProject,
} from "./projects.js";

/** File routes carry the project-relative path in the query; "" is the root. */
const PathQuery = z.object({
	path: z.string().max(1024).optional(),
	download: z.string().optional(),
	upload: z.string().optional(),
	check: z.string().optional(),
	after: TreeAfter.optional(),
	[NO_LINKS_QUERY]: z.string().optional(),
});

function queryPath(request: FastifyRequest): {
	path: string;
	download: boolean;
	upload: boolean;
	check: boolean;
	after: string | undefined;
	noLinks: boolean;
} {
	const parsed = PathQuery.safeParse(request.query ?? {});
	if (!parsed.success) {
		throw new AgentFailure("PATH_INVALID", "invalid path");
	}
	return {
		path: parsed.data.path ?? "",
		download: parsed.data.download === "1",
		upload: parsed.data.upload === "1",
		check: parsed.data.check === "1",
		after: parsed.data.after,
		noLinks: parsed.data[NO_LINKS_QUERY] === "1",
	};
}

/** The archive route takes `path` once, or repeated for a selection (SPEC.md §11.2). */
const ArchiveQuery = z.object({
	path: z
		.union([
			z.string().max(1024),
			z.array(z.string().max(1024)).max(MAX_DOWNLOAD_PATHS),
		])
		.optional(),
	check: z.string().optional(),
});

/** Strip the quotes an HTTP entity tag is usually sent with. */
function unquote(value: string): string {
	return value.replace(/^W\//, "").replace(/^"|"$/g, "");
}

/**
 * Housekeeping after the agent writes at `path`: a write under `.portikus/`
 * adds the exclude lines (SPEC.md §7.2), and a paste removes old pastes
 * (SPEC.md §9.6). A failure here must never fail the write itself.
 */
export async function afterWrite(
	log: FastifyBaseLogger,
	homeDir: string,
	slug: string,
	path: string,
): Promise<void> {
	if (path !== ".portikus" && !path.startsWith(".portikus/")) return;
	let projectPath: string;
	try {
		projectPath = (await resolveProject(slug, homeDir)).path;
	} catch (error) {
		log.warn({ slug, err: error }, "could not update the exclude file");
		return;
	}
	try {
		await excludeOnPortikusWrite(projectPath, path);
	} catch (error) {
		log.warn({ slug, err: error }, "could not update the exclude file");
	}
	if (!path.startsWith(`${PASTES_DIR}/`)) return;
	try {
		await removeOldPastes(projectPath);
	} catch (error) {
		log.warn({ slug, err: error }, "could not remove old pastes");
	}
}

/** The file routes. Paths are logged at debug only and file contents never (STACK.md §15). */
export async function filesRoutes(
	instance: FastifyInstance,
	options: { homeDir: string },
): Promise<void> {
	const { homeDir } = options;
	instance.get("/projects/:slug/tree", async (request, reply) => {
		const { slug } = request.params as { slug: string };
		try {
			const { path, after, noLinks } = queryPath(request);
			return await listDir(homeDir, slug, path, after, { noLinks });
		} catch (error) {
			return sendError(request, reply, error, "INTERNAL");
		}
	});

	instance.get("/projects/:slug/file", async (request, reply) => {
		const { slug } = request.params as { slug: string };
		try {
			const { path, download, noLinks } = queryPath(request);
			const file = await readFile(homeDir, slug, path, { download, noLinks });
			if (file.etag) {
				reply.header("etag", file.etag);
			}
			reply.header("content-length", String(file.size));
			if (download) {
				reply.header("content-disposition", contentDisposition(basename(path)));
			}
			return reply.type(file.contentType).send(file.stream ?? file.body);
		} catch (error) {
			return sendError(request, reply, error, "INTERNAL");
		}
	});

	// A local image for an assistant reply, read-only and confined to the
	// home folder (SPEC.md §24.1).
	instance.get("/projects/:slug/image", async (request, reply) => {
		const { slug } = request.params as { slug: string };
		try {
			const { path } = queryPath(request);
			const image = await readChatImage(homeDir, slug, path);
			reply.header("content-length", String(image.body.length));
			return reply.type(image.contentType).send(image.body);
		} catch (error) {
			return sendError(request, reply, error, "INTERNAL");
		}
	});

	// The write route reads the raw request stream for every content type, so
	// the parsers that displace Fastify's JSON and text ones live in this
	// scope alone; every other route keeps Fastify's defaults. The size cap is
	// enforced while the body streams to disk, not by a route body limit,
	// which a stream parser never consults (SPEC.md §11.2).
	instance.register(async (writeScope) => {
		const rawStream = (
			_request: FastifyRequest,
			payload: Readable,
			done: (error: Error | null, body?: Readable) => void,
		) => {
			done(null, payload);
		};
		writeScope.addContentTypeParser("*", rawStream);
		writeScope.addContentTypeParser("application/json", rawStream);
		writeScope.addContentTypeParser("text/plain", rawStream);

		writeScope.put("/projects/:slug/file", async (request, reply) => {
			const { slug } = request.params as { slug: string };
			try {
				const { path, upload } = queryPath(request);
				const ifMatch = request.headers["if-match"];
				const ifNoneMatch = request.headers["if-none-match"];
				// ?upload=1 is the explicit signal. The octet-stream content type is
				// still accepted as an alias for the clients that send it.
				const contentType = request.headers["content-type"] ?? "";
				const result = await writeFile(homeDir, slug, path, request.raw, {
					ifMatch: typeof ifMatch === "string" ? unquote(ifMatch) : undefined,
					ifNoneMatch: ifNoneMatch === "*",
					upload: upload || contentType.startsWith("application/octet-stream"),
				});
				await afterWrite(request.log, homeDir, slug, path);
				reply.header("etag", result.etag);
				return reply.code(200).send(result);
			} catch (error) {
				if (
					error instanceof AgentFailure &&
					error.code === "FILE_TOO_LARGE" &&
					!request.raw.readableEnded
				) {
					// The rest of the body is never read, so the connection cannot be
					// reused; say so, and only tear the socket down once the 413 has
					// gone out, or the client sees a reset instead (SPEC.md §13.5).
					reply.header("connection", "close");
					reply.raw.once("finish", () => {
						request.raw.destroy();
					});
				}
				return sendError(request, reply, error, "INTERNAL");
			}
		});
	});

	instance.delete("/projects/:slug/file", async (request, reply) => {
		const { slug } = request.params as { slug: string };
		try {
			const { path } = queryPath(request);
			await remove(homeDir, slug, path);
			return reply.code(204).send();
		} catch (error) {
			return sendError(request, reply, error, "INTERNAL");
		}
	});

	instance.post("/projects/:slug/mkdir", async (request, reply) => {
		const { slug } = request.params as { slug: string };
		try {
			const parsed = MkdirRequest.safeParse(request.body);
			if (!parsed.success) {
				throw new AgentFailure("PATH_INVALID", "invalid path");
			}
			await mkdir(homeDir, slug, parsed.data.path);
			await afterWrite(request.log, homeDir, slug, parsed.data.path);
			return reply.code(201).send({ ok: true });
		} catch (error) {
			return sendError(request, reply, error, "INTERNAL");
		}
	});

	instance.post("/projects/:slug/extract", async (request, reply) => {
		const { slug } = request.params as { slug: string };
		try {
			const parsed = ExtractRequest.safeParse(request.body);
			if (!parsed.success) {
				throw new AgentFailure("PATH_INVALID", "invalid path");
			}
			// An API timeout closes the connection; unzip must not outlive it.
			const path = await extractZip(
				homeDir,
				slug,
				parsed.data.path,
				abortOnDisconnect(reply),
			);
			return reply.code(201).send({ path });
		} catch (error) {
			return sendError(request, reply, error, "INTERNAL");
		}
	});

	instance.post("/projects/:slug/move", async (request, reply) => {
		const { slug } = request.params as { slug: string };
		try {
			const parsed = MoveRequest.safeParse(request.body);
			if (!parsed.success) {
				throw new AgentFailure("PATH_INVALID", "invalid path");
			}
			await move(
				homeDir,
				slug,
				parsed.data.from,
				parsed.data.to,
				parsed.data.replace ?? false,
			);
			await afterWrite(request.log, homeDir, slug, parsed.data.to);
			return reply.code(204).send();
		} catch (error) {
			return sendError(request, reply, error, "INTERNAL");
		}
	});

	instance.get("/projects/:slug/extract/progress", async (request) => {
		const { slug } = request.params as { slug: string };
		return extractProgress(slug);
	});

	instance.get("/projects/:slug/archive", async (request, reply) => {
		const { slug } = request.params as { slug: string };
		let archive: Readable;
		// A download the browser gave up on must not leave zip running.
		const signal = abortOnDisconnect(reply);
		try {
			const parsed = ArchiveQuery.safeParse(request.query ?? {});
			if (!parsed.success) {
				throw new AgentFailure("PATH_INVALID", "invalid path");
			}
			const asked = parsed.data.path;
			const paths = Array.isArray(asked) ? asked : [asked ?? ""];
			if (parsed.data.check === "1") {
				await checkArchiveSize(homeDir, slug, paths);
				return reply.code(204).send();
			}
			archive = await buildArchive(homeDir, slug, paths, signal);
		} catch (error) {
			return sendError(request, reply, error, "INTERNAL");
		}
		request.log.debug({ slug, operation: "archive" }, "project operation");
		return reply.type("application/zip").send(archive);
	});
}

/**
 * Refuse a download over the cap before it starts, so the browser can
 * explain a refusal first.
 */
async function checkArchiveSize(
	homeDir: string,
	slug: string,
	asked: readonly string[],
): Promise<void> {
	if (asked.length > 1) {
		const paths = await resolveSelection(homeDir, slug, asked);
		await checkDownloadSize(outermostPaths(paths));
		return;
	}
	const target = await resolveInProject(homeDir, slug, asked[0] ?? "", {
		mustExist: true,
	});
	await checkDownloadSize([target.path]);
}

/** The zip of a selection, one folder, or the whole project. */
async function buildArchive(
	homeDir: string,
	slug: string,
	asked: readonly string[],
	signal: AbortSignal,
): Promise<Readable> {
	if (asked.length > 1) {
		const paths = await resolveSelection(homeDir, slug, asked);
		return archiveSelection(paths, signal);
	}
	const path = asked[0] ?? "";
	if (path === "") return archiveProject(slug, homeDir, signal);
	const target = await resolveInProject(homeDir, slug, path, { mustExist: true });
	return archiveDir(target.path, signal);
}

/**
 * Confine each selected path to the project, keeping a selected symlink as
 * the link itself, which `zip -y` stores without following (SPEC.md §24.6).
 */
async function resolveSelection(
	homeDir: string,
	slug: string,
	relPaths: readonly string[],
): Promise<string[]> {
	const paths: string[] = [];
	for (const relPath of relPaths) {
		const target = await resolveInProject(homeDir, slug, relPath, {
			mustExist: true,
			linkOk: true,
		});
		paths.push(target.path);
	}
	return paths;
}
