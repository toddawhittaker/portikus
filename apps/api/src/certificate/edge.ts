import type { ApiConfig } from "@portikus/config";
import { type ApiError, parsePreviewHost } from "@portikus/contracts";
import type { Database } from "@portikus/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import { fromLoopback } from "../loopback.js";
import { portAllowed } from "../preview/policy.js";
import type { ListeningRegistry } from "../preview/registry.js";
import { type Counter, check, createCounter } from "../rate-limit.js";
import { type NonceStore, PREFLIGHT_PATH } from "./preflight.js";

/**
 * Two routes Caddy reaches without a session (SPEC.md 20.1, 24.11). They
 * answer in an onRequest hook added before the auth plugin, as the sign-in
 * throttle does, so the auth hook never asks them for a cookie.
 *
 * - `GET /edge/certificate-ask?domain=<name>`: Caddy's on-demand TLS asks
 *   before issuing a certificate for a preview name (HTTP-01). 200 only for
 *   the site and for `<label>-<port>.<suffix>` where the listening registry
 *   shows that port listening in that running workspace, the listener is
 *   not a system one, and the workspace is under its hourly cap of new names; 404 for anything
 *   else, so made-up names cannot spend the CA's rate limit. Loopback only.
 * - `GET /.well-known/portikus-preflight/<nonce>`: answers the nonce back
 *   while it is live, which proves to the pre-flight that a name reaches
 *   this server.
 */
const CERTIFICATE_ASK_PATH = "/edge/certificate-ask";
const NONCE_ROUTE = `${PREFLIGHT_PATH}:nonce`;

/** Most new preview names one workspace may get approved per fixed one-hour
 * window; a burst of up to twice this across a window edge is accepted. */
export const NEW_NAMES_PER_WORKSPACE_PER_HOUR = 10;
const WINDOW_MS = 60 * 60 * 1000;

/**
 * Caps how many new preview names each workspace can send to the CA, so one
 * student listening on many ports cannot spend the site's rate limit
 * (SPEC.md 24). Held in memory: an API restart resets the window, which is
 * acceptable because the CA's own limits still apply.
 */
export class PreviewApprovals {
	// Approved names stay approved: Caddy holds their certificates, and the
	// new-name limit below bounds how fast this set can grow.
	private readonly approved = new Set<string>();
	private readonly newNames: Counter;

	constructor(
		private readonly warn: (workspaceId: string) => void = () => {},
		now: () => number = Date.now,
	) {
		this.newNames = createCounter(NEW_NAMES_PER_WORKSPACE_PER_HOUR, WINDOW_MS, now);
	}

	/** True if `name` was approved before or the workspace still has room this hour. */
	admit(workspaceId: string, name: string): boolean {
		if (this.approved.has(name)) return true;
		const decision = check(this.newNames, workspaceId);
		if (!decision.allowed) {
			if (decision.firstRefusal) this.warn(workspaceId);
			return false;
		}
		this.approved.add(name);
		return true;
	}
}

/** Whether Caddy may get a certificate for `domain`. */
export async function askAllows(
	db: Kysely<Database>,
	config: ApiConfig,
	registry: Pick<ListeningRegistry, "service">,
	approvals: PreviewApprovals,
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
		.where("state", "=", "running")
		.executeTakeFirst();
	if (workspace === undefined) return false;
	const service = registry.service(workspace.id, parsed.port);
	// System listeners (SPEC.md 18.2) run in every workspace with no student action.
	if (service === undefined || service.system) return false;
	return approvals.admit(workspace.id, name);
}

/** Call before registering the auth plugin. */
export function registerCertificateEdge(
	app: FastifyInstance,
	deps: {
		db: Kysely<Database>;
		config: ApiConfig;
		nonces: NonceStore;
		registry: ListeningRegistry;
	},
): void {
	const approvals = new PreviewApprovals((workspaceId) =>
		app.log.warn(
			{ workspaceId, limit: NEW_NAMES_PER_WORKSPACE_PER_HOUR },
			"certificate ask refused: too many new preview names this hour",
		),
	);
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
			typeof domain === "string" &&
			(await askAllows(deps.db, deps.config, deps.registry, approvals, domain));
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
	const unreachable = async (_request: FastifyRequest, reply: FastifyReply) => {
		return reply.status(404).send({ code: "NOT_FOUND", message: "Not found." });
	};
	app.get(CERTIFICATE_ASK_PATH, unreachable);
	app.get(NONCE_ROUTE, unreachable);
}
