import { requireUser } from "@portikus/auth";
import type { ApiConfig } from "@portikus/config";
import {
	type ListeningService,
	type PreviewEmbeddableResponse,
	PreviewGrantRequest,
	type PreviewGrantResponse,
	parsePreviewHost,
	previewHost,
} from "@portikus/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { AgentCallError } from "../agent-client.js";
import { createBridgeForwards, parseBridgeUri } from "../preview/bridge.js";
import { type EmbeddableVerdict, probeEmbeddable } from "../preview/embeddable.js";
import {
	inactiveServicePage,
	refusedPage,
	resetPage,
	signInPage,
	stoppedWorkspacePage,
} from "../preview/pages.js";
import { portAllowed, previewOriginFor, requestHost } from "../preview/policy.js";
import type { ListeningRegistry } from "../preview/registry.js";
import {
	consumeGrant,
	createGrant,
	createPreviewSession,
	hashToken,
	loadMainSessionUser,
	loadPreviewSession,
	revokePreviewSession,
	revokeWorkspacePreviewSessions,
} from "../preview/store.js";
import type { ServerDeps } from "../server.js";
import { findWorkspaceOwnedBy } from "./workspace-view.js";

/** The preview-host cookie, `__Host-` prefixed wherever the site is https. */
export function previewCookieName(config: ApiConfig): string {
	return config.PUBLIC_URL.startsWith("https:")
		? "__Host-portikus-preview"
		: "portikus-preview";
}

/** RFC 6265 cookie-name characters, so nothing else reaches a header. */
const COOKIE_NAME = /^[!#$%&'*+\-.0-9A-Z^_`a-z|~]+$/;

const IdParams = z.object({ id: z.string().uuid() });
const TicketQuery = z.object({ t: z.string().min(1).max(200) });
const PortQuery = z.object({ port: z.coerce.number().int().min(1).max(65535) });

/**
 * How many preview requests one student may make in a minute, counting
 * bootstrap tickets and framing probes together. Both make the control plane
 * work on the student's behalf — a probe holds an outbound socket for up to
 * three seconds — so they share one budget. Opening a preview, reloading it
 * and switching ports are all well under this; a page asking in a loop is
 * not. Counted in this process, which the pilot runs one of (ADR 0010).
 */
const PREVIEW_REQUESTS_PER_WINDOW = 30;
const PREVIEW_WINDOW_MS = 60_000;

/** The socket's own peer address, which no header can influence. */
function fromLoopback(request: FastifyRequest): boolean {
	const address = request.raw.socket.remoteAddress ?? "";
	return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

/** Send a Portikus-owned page. Nothing from the request is echoed. */
function page(reply: FastifyReply, status: number, html: string): FastifyReply {
	return reply
		.status(status)
		.header("content-type", "text/html; charset=utf-8")
		.header("cache-control", "no-store")
		.header("referrer-policy", "no-referrer")
		.send(html);
}

/**
 * Preview grants, the bootstrap and reset endpoints on the preview host, and
 * the edge authorization subrequest (SPEC.md §14, §24.7;
 * BROWSER-HANDLING.md §9, §10, §11, §16, §17).
 */
export function registerPreviewRoutes(
	app: FastifyInstance,
	{ db, config, logger, registry }: ServerDeps & { registry: ListeningRegistry },
): void {
	const cookieName = previewCookieName(config);
	const secure = config.PUBLIC_URL.startsWith("https:");
	const bridge = createBridgeForwards({ registry, logger });

	/** When each user's recent grants and probes were asked for, newest last. */
	const requestTimes = new Map<string, number[]>();

	/** Record this preview request, and say whether it is over the limit. */
	function overPreviewLimit(userId: string): boolean {
		const now = Date.now();
		const recent = (requestTimes.get(userId) ?? []).filter(
			(at) => now - at < PREVIEW_WINDOW_MS,
		);
		if (recent.length >= PREVIEW_REQUESTS_PER_WINDOW) {
			requestTimes.set(userId, recent);
			return true;
		}
		recent.push(now);
		requestTimes.set(userId, recent);
		return false;
	}

	/**
	 * The framing probe running for a workspace, if any. One at a time per
	 * workspace, so a page cannot make the control plane hold a pile of
	 * outbound sockets open: a second call for the same port waits on the
	 * first and takes its answer, and one for another port waits its turn.
	 */
	const probes = new Map<
		string,
		{ port: number; answer: Promise<EmbeddableVerdict> }
	>();

	async function probeOnce(
		workspaceId: string,
		port: number,
		upstream: string,
	): Promise<EmbeddableVerdict> {
		const running = probes.get(workspaceId);
		if (running) {
			// The catch is only so a failed probe does not reject this waiter
			// too; probeEmbeddable answers rather than throwing.
			const earlier = await running.answer.catch(
				(): EmbeddableVerdict => ({ embeddable: false, reason: "unreachable" }),
			);
			if (running.port === port) return earlier;
			return probeOnce(workspaceId, port, upstream);
		}
		const answer = probeEmbeddable(upstream, config.PUBLIC_URL).finally(() => {
			if (probes.get(workspaceId)?.answer === answer) probes.delete(workspaceId);
		});
		probes.set(workspaceId, { port, answer });
		return answer;
	}

	/** What the workspace agent reports, plus the policy verdict. */
	function servicesOf(workspaceId: string): ListeningService[] {
		return registry.services(workspaceId);
	}

	app.get("/workspaces/:id/listening", async (request, reply) => {
		const user = requireUser(request);
		const params = IdParams.safeParse(request.params);
		if (!params.success) {
			return reply
				.status(400)
				.send({ code: "VALIDATION_FAILED", message: "invalid workspace id" });
		}
		const workspace = await findWorkspaceOwnedBy(db, params.data.id, user.id);
		if (!workspace) {
			return reply
				.status(404)
				.send({ code: "WORKSPACE_NOT_FOUND", message: "Workspace not found" });
		}
		return reply.send({ services: servicesOf(params.data.id) });
	});

	app.post("/workspaces/:id/preview-grants", async (request, reply) => {
		const user = requireUser(request);
		const params = IdParams.safeParse(request.params);
		if (!params.success) {
			return reply
				.status(400)
				.send({ code: "VALIDATION_FAILED", message: "invalid workspace id" });
		}
		const body = PreviewGrantRequest.safeParse(request.body);
		if (!body.success) {
			return reply
				.status(400)
				.send({ code: "VALIDATION_FAILED", message: "invalid grant request" });
		}

		const workspace = await findWorkspaceOwnedBy(db, params.data.id, user.id);
		if (!workspace) {
			return reply
				.status(404)
				.send({ code: "WORKSPACE_NOT_FOUND", message: "Workspace not found" });
		}
		if (workspace.state !== "running") {
			return reply.status(409).send({
				code: "WORKSPACE_NOT_RUNNING",
				message: "Start the workspace before opening a preview",
			});
		}
		if (!portAllowed(config, body.data.port)) {
			return reply.status(403).send({
				code: "PREVIEW_PORT_NOT_ALLOWED",
				message: `Port ${body.data.port} cannot be previewed`,
			});
		}
		if (overPreviewLimit(user.id)) {
			request.log.warn(
				{ workspaceId: params.data.id },
				"preview grant rate limit reached",
			);
			return reply.status(429).send({
				code: "PREVIEW_RATE_LIMITED",
				message: "Too many previews were opened just now. Wait a moment.",
			});
		}

		// A service bound only to loopback needs the agent's forward before the
		// gateway can reach it (BROWSER-HANDLING.md §11.1).
		const service = registry.service(params.data.id, body.data.port);
		if (service && service.previewReachability === "unknown") {
			try {
				await registry.ensureReachable(params.data.id, body.data.port);
			} catch (error) {
				request.log.warn(
					{
						workspaceId: params.data.id,
						port: body.data.port,
						code: error instanceof AgentCallError ? error.code : "INTERNAL",
					},
					"loopback forward could not be opened",
				);
				return reply.status(409).send({
					code: "PREVIEW_FORWARD_FAILED",
					message:
						`Portikus could not reach port ${body.data.port} inside the ` +
						"workspace. Try again, or bind the application to 0.0.0.0.",
				});
			}
		}

		const host = previewHost(
			workspace.label as string,
			body.data.port,
			config.PREVIEW_SUFFIX,
		);
		const { ticket, expiresAt } = await createGrant(db, {
			userId: user.id,
			// The plugin gave us a live session, so the token is present.
			sessionId: sessionIdOf(request),
			workspaceId: params.data.id,
			port: body.data.port,
			previewHost: host,
			presentation: body.data.presentation,
			ttlSeconds: config.PREVIEW_TICKET_TTL_SECONDS,
		});

		const origin = previewOriginFor(config, host);
		const payload: PreviewGrantResponse = {
			previewOrigin: origin,
			bootstrapUrl: `${origin}/__portikus/bootstrap?t=${encodeURIComponent(ticket)}`,
			expiresAt: expiresAt.toISOString(),
		};
		return reply
			.header("cache-control", "no-store")
			.header("referrer-policy", "no-referrer")
			.status(201)
			.send(payload);
	});

	/**
	 * Whether the application on this port allows being framed
	 * (BROWSER-HANDLING.md §12). A GET with no side effect, so no CSRF token
	 * is needed; the session and workspace ownership are still checked.
	 *
	 * The address probed comes from the workspace row and the listening
	 * registry, exactly as `/preview/authorize` takes it, never from the
	 * request — see apps/api/src/preview/embeddable.ts for why that makes
	 * server-side request forgery impossible here.
	 */
	app.get("/workspaces/:id/preview/embeddable", async (request, reply) => {
		const user = requireUser(request);
		const params = IdParams.safeParse(request.params);
		const query = PortQuery.safeParse(request.query);
		if (!params.success || !query.success) {
			return reply
				.status(400)
				.send({ code: "VALIDATION_FAILED", message: "invalid workspace or port" });
		}
		const workspace = await findWorkspaceOwnedBy(db, params.data.id, user.id);
		if (!workspace) {
			return reply
				.status(404)
				.send({ code: "WORKSPACE_NOT_FOUND", message: "Workspace not found" });
		}
		const port = query.data.port;
		if (!portAllowed(config, port)) {
			return reply.status(403).send({
				code: "PREVIEW_PORT_NOT_ALLOWED",
				message: `Port ${port} cannot be previewed`,
			});
		}
		if (overPreviewLimit(user.id)) {
			request.log.warn(
				{ workspaceId: params.data.id },
				"preview probe rate limit reached",
			);
			return reply.status(429).send({
				code: "PREVIEW_RATE_LIMITED",
				message: "Too many previews were opened just now. Wait a moment.",
			});
		}

		const unreachable: PreviewEmbeddableResponse = {
			embeddable: false,
			reason: "unreachable",
		};
		const address = workspace.agent_address as string | null;
		const service = registry.service(params.data.id, port);
		if (
			workspace.state !== "running" ||
			!address ||
			!service ||
			(service.previewReachability !== "reachable" &&
				service.previewReachability !== "forwarded")
		) {
			return reply.header("cache-control", "no-store").send(unreachable);
		}

		const verdict = await probeOnce(params.data.id, port, `${address}:${port}`);
		return reply.header("cache-control", "no-store").send(verdict);
	});

	app.post("/workspaces/:id/preview/reset", async (request, reply) => {
		const user = requireUser(request);
		const params = IdParams.safeParse(request.params);
		if (!params.success) {
			return reply
				.status(400)
				.send({ code: "VALIDATION_FAILED", message: "invalid workspace id" });
		}
		const workspace = await findWorkspaceOwnedBy(db, params.data.id, user.id);
		if (!workspace) {
			return reply
				.status(404)
				.send({ code: "WORKSPACE_NOT_FOUND", message: "Workspace not found" });
		}
		await revokeWorkspacePreviewSessions(db, params.data.id);
		await bridge.closeForWorkspace(params.data.id);
		for (const service of servicesOf(params.data.id)) {
			if (service.previewReachability !== "forwarded") continue;
			await registry.closeForward(params.data.id, service.port).catch(() => undefined);
		}
		return reply.status(204).send();
	});

	// ── Preview host: Caddy proxies these two paths straight to the API ──

	app.get("/__portikus/bootstrap", async (request, reply) => {
		const host = requestHost(request.headers as Record<string, unknown>);
		const query = TicketQuery.safeParse(request.query);
		if (!host || !query.success) return page(reply, 403, refusedPage());
		// A host that does not parse cannot match a grant either, but checking
		// here keeps a malformed name away from the database.
		if (parsePreviewHost(host, config.PREVIEW_SUFFIX) === null) {
			return page(reply, 403, refusedPage());
		}

		const grant = await consumeGrant(db, query.data.t, host);
		if (!grant) return page(reply, 403, refusedPage());

		// A ticket is good only where it was meant to be opened: one asked for
		// the preview frame may not be turned into a top-level page, and one
		// asked for a tab may not be framed (BROWSER-HANDLING.md §9.1). An
		// older browser sends no Sec-Fetch-Dest at all, and is accepted: the
		// header is a tightening, never the only thing holding the door.
		const dest = request.headers["sec-fetch-dest"];
		if (typeof dest === "string" && dest !== "") {
			const wanted = grant.presentation === "embedded" ? "iframe" : "document";
			if (dest !== wanted) return page(reply, 403, refusedPage());
		}

		const token = await createPreviewSession(db, {
			userId: grant.user_id,
			sessionId: grant.session_id,
			workspaceId: grant.workspace_id,
			port: grant.port,
			previewHost: grant.preview_host,
		});

		return reply
			.setCookie(cookieName, token, {
				httpOnly: true,
				secure,
				sameSite: "strict",
				path: "/",
			})
			.header("cache-control", "no-store")
			.header("referrer-policy", "no-referrer")
			.redirect("/", 303);
	});

	/**
	 * Clear the browser data this preview origin holds
	 * (BROWSER-HANDLING.md §16.4).
	 *
	 * The answer is the same with or without a valid preview cookie: 200 with
	 * `Clear-Site-Data: "storage"`, which drops the origin's storage and its
	 * service worker registrations. A caller with no session can therefore do
	 * no more than clear its own browser's data for this one origin; the
	 * server-side session is revoked only when a real cookie came with the
	 * request.
	 *
	 * "cookies" must never be added to that list. Browsers apply the cookies
	 * directive to the whole registrable domain, not just this origin, and in
	 * a same-site deployment the preview hosts and the Portikus host share
	 * that domain — so it would delete the student's `__Host-portikus-session`
	 * cookie and sign them out of Portikus. The cookies this origin does own
	 * are expired one by one instead: the fetch is made with credentials, so
	 * the request carries the preview origin's cookies, and Caddy strips only
	 * the Portikus preview cookie before the API sees it. Every name that
	 * arrives is sent back expired, which clears the student application's
	 * own cookies without touching the Portikus session.
	 *
	 * Only cookies the application set on the path `/` are cleared. One set on
	 * a narrower path, or for a parent domain, survives; nothing the request
	 * carries says which it was.
	 *
	 * Portikus calls this from its own page rather than from inside the
	 * preview frame, because an application's service worker can answer a
	 * navigation made by the frame but not a request from a document it does
	 * not control.
	 */
	app.get("/__portikus/reset", async (request, reply) => {
		const token = request.cookies[cookieName];
		if (token) {
			const session = await loadPreviewSession(db, token);
			if (session) {
				await revokePreviewSession(db, session.id);
				await bridge.closeForSession(session.id);
			}
		}
		for (const name of Object.keys(request.cookies)) {
			if (name === cookieName) continue;
			// Anything that is not a cookie name is dropped rather than echoed
			// into a response header.
			if (!COOKIE_NAME.test(name)) continue;
			reply.header(
				"set-cookie",
				`${name}=; Path=/; Max-Age=0${secure ? "; Secure" : ""}`,
			);
		}
		return reply
			.clearCookie(cookieName, { path: "/", secure, sameSite: "strict" })
			.header("clear-site-data", '"storage"')
			.header("content-type", "text/html; charset=utf-8")
			.header("cache-control", "no-store")
			.header("referrer-policy", "no-referrer")
			.status(200)
			.send(resetPage());
	});

	// ── The edge authorization subrequest (ADR 0018, BROWSER-HANDLING §10) ──

	app.get("/preview/authorize", async (request, reply) => {
		// Only Caddy on this machine may ask. The peer address is used, not
		// request.ip, which trustProxy would let a forwarded header move.
		if (!fromLoopback(request)) {
			return page(reply, 403, refusedPage());
		}

		const host = requestHost(request.headers as Record<string, unknown>);
		if (!host) return page(reply, 403, refusedPage());
		const parsed = parsePreviewHost(host, config.PREVIEW_SUFFIX);
		if (!parsed) return page(reply, 403, refusedPage());

		const token = request.cookies[cookieName];
		if (!token) return page(reply, 401, signInPage());
		const session = await loadPreviewSession(db, token);
		if (!session) return page(reply, 401, signInPage());

		// The preview session lives with the main one (BROWSER-HANDLING §9.2).
		const user = await loadMainSessionUser(db, session.session_id);
		if (!user || user.id !== session.user_id) return page(reply, 401, signInPage());

		if (session.preview_host !== host) return page(reply, 403, refusedPage());
		if (session.port !== parsed.port) return page(reply, 403, refusedPage());
		if (!portAllowed(config, session.port)) return page(reply, 403, refusedPage());

		const workspace = await db
			.selectFrom("workspaces")
			.select(["id", "label", "state", "owner_user_id", "agent_address"])
			.where("id", "=", session.workspace_id)
			.executeTakeFirst();
		if (!workspace) return page(reply, 403, refusedPage());
		if (workspace.owner_user_id !== session.user_id) {
			return page(reply, 403, refusedPage());
		}
		if (workspace.label !== parsed.label) return page(reply, 403, refusedPage());
		if (workspace.state !== "running") {
			return page(reply, 503, stoppedWorkspacePage());
		}

		// The same-origin port bridge may name another port of this same
		// workspace (BROWSER-HANDLING.md §14, pattern 2). Anything else under
		// the reserved prefix is refused rather than quietly treated as the
		// session's own port.
		const headers = request.headers as Record<string, unknown>;
		const target = parseBridgeUri(headers["x-forwarded-uri"]);
		if (target.kind === "invalid") return page(reply, 403, refusedPage());
		const port = target.kind === "port" ? target.port : session.port;
		if (!portAllowed(config, port)) return page(reply, 403, refusedPage());

		if (!workspace.agent_address) {
			return page(reply, 503, inactiveServicePage(port));
		}

		// Only this workspace's registry is consulted, so the bridge can never
		// reach another student's service (BROWSER-HANDLING.md §16.3).
		const service = registry.service(session.workspace_id, port);
		if (!service || service.previewReachability === "denied") {
			return page(reply, 503, inactiveServicePage(port));
		}
		if (target.kind !== "port") {
			// The session's own port got its forward when the grant was issued.
			if (service.previewReachability === "unknown") {
				return page(reply, 503, inactiveServicePage(port));
			}
		} else {
			// Every bridge request goes through the bridge, even when the port
			// is already reachable: that is how a second session using a
			// forward the bridge opened gets counted, so the forward outlives
			// whichever session ends first. A port that needs no forward costs
			// nothing here.
			try {
				await bridge.ensure(session.workspace_id, session.id, port);
			} catch (error) {
				request.log.warn(
					{
						workspaceId: session.workspace_id,
						port,
						code: error instanceof AgentCallError ? error.code : "INTERNAL",
					},
					"bridge forward could not be opened",
				);
				return page(reply, 503, inactiveServicePage(port));
			}
		}

		// The upstream comes from the workspace row and a port the registry
		// vouched for, never from anything the request carries (SPEC.md §24.7).
		return reply
			.header("x-portikus-upstream", `${workspace.agent_address}:${port}`)
			.header("cache-control", "no-store")
			.status(200)
			.send();
	});
}

/** The main session's row id, which is the hash of its cookie token. */
function sessionIdOf(request: FastifyRequest): string {
	const token = request.sessionToken;
	if (!token) throw new Error("preview grant reached without a session");
	return hashToken(token);
}
