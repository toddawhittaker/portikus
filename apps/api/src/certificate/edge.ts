import type { ApiConfig } from "@portikus/config";
import { type ApiError, parsePreviewHost } from "@portikus/contracts";
import type { Database } from "@portikus/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import { portAllowed } from "../preview/policy.js";
import { type NonceStore, PREFLIGHT_PATH } from "./preflight.js";

/**
 * Two routes Caddy reaches without a session (SPEC.md 20.1, 24.11). They
 * answer in an onRequest hook added before the auth plugin, as the sign-in
 * throttle does, so the auth hook never asks them for a cookie.
 *
 * - `GET /edge/certificate-ask?domain=<name>`: Caddy's on-demand TLS asks
 *   before issuing a certificate for a preview name (HTTP-01). 200 only for
 *   the site and for `<label>-<port>.<suffix>` of an existing workspace on
 *   a port previews may use; 404 for anything else. Loopback only.
 * - `GET /.well-known/portikus-preflight/<nonce>`: answers the nonce back
 *   while it is live, which proves to the pre-flight that a name reaches
 *   this server.
 */
export const CERTIFICATE_ASK_PATH = "/edge/certificate-ask";
const NONCE_ROUTE = `${PREFLIGHT_PATH}:nonce`;

function fromLoopback(request: FastifyRequest): boolean {
	const address = request.raw.socket.remoteAddress ?? "";
	return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

/** Whether Caddy may get a certificate for `domain`. */
export async function askAllows(
	db: Kysely<Database>,
	config: ApiConfig,
	domain: string,
): Promise<boolean> {
	const name = domain.toLowerCase();
	if (name === new URL(config.PUBLIC_URL).hostname.toLowerCase()) return true;
	const parsed = parsePreviewHost(name, config.PREVIEW_SUFFIX);
	if (!parsed || !portAllowed(config, parsed.port)) return false;
	const workspace = await db
		.selectFrom("workspaces")
		.select("id")
		.where("label", "=", parsed.label)
		.executeTakeFirst();
	return workspace !== undefined;
}

/** Call before registering the auth plugin. */
export function registerCertificateEdge(
	app: FastifyInstance,
	deps: { db: Kysely<Database>; config: ApiConfig; nonces: NonceStore },
): void {
	app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
		const url = request.routeOptions.url ?? "";
		if (url === NONCE_ROUTE) {
			const { nonce } = request.params as { nonce: string };
			if (!deps.nonces.has(nonce)) {
				const body: ApiError = { code: "NOT_FOUND", message: "Not found." };
				await reply.status(404).send(body);
				return;
			}
			await reply
				.header("content-type", "text/plain; charset=utf-8")
				.header("cache-control", "no-store")
				.send(nonce);
			return;
		}
		if (url !== CERTIFICATE_ASK_PATH) return;
		if (!fromLoopback(request)) {
			const body: ApiError = { code: "FORBIDDEN", message: "Forbidden." };
			await reply.status(403).send(body);
			return;
		}
		const domain = (request.query as { domain?: unknown }).domain;
		const allowed =
			typeof domain === "string" && (await askAllows(deps.db, deps.config, domain));
		if (allowed) {
			await reply.status(200).send();
			return;
		}
		const body: ApiError = { code: "NOT_FOUND", message: "Not found." };
		await reply.status(404).send(body);
	});
}

/** The routes the hook answers; registered inside the server's plugin so the route list sees them. */
export function registerCertificateEdgeRoutes(app: FastifyInstance): void {
	const unreachable = async (_request: FastifyRequest, reply: FastifyReply) =>
		reply.status(404).send({ code: "NOT_FOUND", message: "Not found." });
	app.get(CERTIFICATE_ASK_PATH, unreachable);
	app.get(NONCE_ROUTE, unreachable);
}
