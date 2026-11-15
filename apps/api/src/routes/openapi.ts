import { requireUser, sessionCookieName } from "@portikus/auth";
import type { ApiError } from "@portikus/contracts";
import type { FastifyInstance } from "fastify";
import { toAuthOptions } from "../auth-options.js";
import { OPERATIONS } from "../catalog/index.js";
import { buildOpenApiDocument, type OpenApiDocument } from "../catalog/openapi.js";
import type { ServerDeps } from "../deps.js";

/** The version of the operation contract the document describes, not of the server build. */
const DOCUMENT_VERSION = "1.0.0";

/**
 * `GET /openapi.json`: the exposed operations as OpenAPI 3.1 (SPEC.md section
 * 27), for any valid API key or a signed-in administrator or instructor.
 * Built once, on first request, since the catalog never changes while the
 * server runs.
 */
export function registerOpenApiRoute(
	app: FastifyInstance,
	deps: Pick<ServerDeps, "config">,
): void {
	let document: OpenApiDocument | undefined;
	app.get("/openapi.json", async (request, reply) => {
		const user = requireUser(request);
		// A key always belongs to staff; a session must still be one.
		if (!request.apiKey && user.role === "student") {
			const body: ApiError = { code: "FORBIDDEN", message: "insufficient role" };
			return reply.code(403).send(body);
		}
		document ??= buildOpenApiDocument(OPERATIONS, {
			version: DOCUMENT_VERSION,
			cookieName: sessionCookieName(toAuthOptions(deps.config)),
		});
		return document;
	});
}
