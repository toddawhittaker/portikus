import { basename } from "node:path";
import { contentDisposition, ProjectPath, TreeAfter } from "@portikus/contracts";
import type { FastifyReply, FastifyRequest } from "fastify";
import { AGENT_TIMEOUT_MS } from "../agent-client.js";
import { sendError } from "../http.js";
import { cappedDownload, DOWNLOAD_RELAY_LIMIT } from "./capped-download.js";

export interface HeadersDeadline {
	signal: AbortSignal;
	abort: () => void;
	clear: () => void;
}

/**
 * A budget for the agent's response headers alone. Once headers are back the
 * body may take as long as it likes, but a wedged agent must not hold a
 * control-plane connection open (SPEC.md §24.6).
 */
export function headersDeadline(): HeadersDeadline {
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
 * The types the file viewer shows in the page, by file extension.
 * Nothing else is ever served inline, and never as HTML.
 */
const INLINE_TYPES: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	svg: "image/svg+xml",
	pdf: "application/pdf",
};

/** The inline content type for `path`, or null when the viewer does not show it. */
export function inlineType(path: string): string | null {
	const name = basename(path);
	const dot = name.lastIndexOf(".");
	if (dot <= 0) return null;
	return INLINE_TYPES[name.slice(dot + 1).toLowerCase()] ?? null;
}

/**
 * The policy on an inline file. `sandbox` gives a document an opaque origin
 * with no script, so an SVG opened on its own cannot reach the session or
 * the page; the rest stops it loading anything but its own inline styles
 * and data images (SPEC.md §24.3).
 */
export const INLINE_CSP =
	"sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'";

/**
 * The project-relative path from the query. Every path is checked here as
 * well as in the agent, so a traversal attempt never leaves the control
 * plane (SPEC.md §11.1, §24.6). The tree of the project root is the one
 * empty path the API accepts.
 */
export function queryPath(
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

/** The agent query for one tree listing, or null after answering 400. */
export function treeQuery(
	request: FastifyRequest,
	reply: FastifyReply,
): { path: string; after?: string } | null {
	const path = queryPath(request, reply, { allowRoot: true });
	if (path === null) return null;
	const rawAfter = (request.query as { after?: unknown }).after;
	if (rawAfter === undefined) return { path };
	const after = TreeAfter.safeParse(rawAfter);
	if (!after.success) {
		sendError(reply, 400, "VALIDATION_FAILED", "that listing token is not valid");
		return null;
	}
	return { path, after: after.data };
}

// Relays the agent's file stream with the headers the viewer, the
// download, and the editor's conditional save each need.
export async function sendFile(
	reply: FastifyReply,
	response: Response,
	body: ReadableStream<Uint8Array>,
	path: string,
	download: boolean,
	inline: string | null,
) {
	const etag = response.headers.get("etag");
	if (etag) reply.header("etag", etag);
	// The editor saves conditionally on this etag, so nothing between
	// here and the browser may rewrite it. Caddy's gzip compression
	// otherwise appends "-gzip" to the etag, the next save sends that
	// back as If-Match, and the agent refuses a save nobody conflicted
	// with (SPEC.md §13.5).
	reply.header("cache-control", "no-transform");
	const length = response.headers.get("content-length");
	if (Number(length) > DOWNLOAD_RELAY_LIMIT) {
		await body.cancel();
		return sendError(
			reply,
			413,
			"FILE_TOO_LARGE",
			"That file is larger than the download limit.",
		);
	}
	if (length) reply.header("content-length", length);
	if (download) {
		// The name comes from the path the student asked for, quoted and
		// escaped here rather than anywhere near a shell.
		reply.header("content-disposition", contentDisposition(basename(path)));
	}
	if (inline) {
		reply.header("x-content-type-options", "nosniff");
		reply.header("content-security-policy", INLINE_CSP);
		reply.type(inline);
	} else {
		reply.type(pinnedType(response.headers.get("content-type")));
	}
	return reply.send(cappedDownload(body));
}
