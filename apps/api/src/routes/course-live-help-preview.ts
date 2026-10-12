import { hashSessionToken, requireUser } from "@portikus/auth";
import {
	type ListeningService,
	PreviewGrantRequest,
	previewHost,
} from "@portikus/contracts";
import { recordAudit } from "@portikus/db";
import type { FastifyInstance } from "fastify";
import { AgentCallError } from "../agent-client.js";
import type { ServerDeps } from "../deps.js";
import { sendError } from "../http.js";
import { liveHelpScope } from "../live-help/gate.js";
import {
	grantResponse,
	PREVIEW_REQUESTS_PER_WINDOW,
	PREVIEW_WINDOW_MS,
	portAllowed,
} from "../preview/policy.js";
import type { ListeningRegistry } from "../preview/registry.js";
import { createGrant } from "../preview/store.js";
import { check, createCounter } from "../rate-limit.js";

/** A listener as the helper sees it: arguments can carry secrets, so no command line. */
function withoutCommandLine(service: ListeningService): ListeningService {
	if (!service.process) return service;
	const { commandLine: _hidden, ...process } = service.process;
	return { ...service, process };
}

/**
 * The helper's previews of the student's workspace during live help, in view
 * and type mode alike (ADR 0063). Both routes go through `liveHelpScope`; the
 * grant is tied to the session, so the preview gateway lets it in only while
 * that session is open.
 */
export function registerCourseLiveHelpPreviewRoutes(
	app: FastifyInstance,
	{ db, config, registry }: ServerDeps & { registry: ListeningRegistry },
): void {
	const grants = createCounter(PREVIEW_REQUESTS_PER_WINDOW, PREVIEW_WINDOW_MS);

	app.get("/courses/:courseId/live-help/:sid/listening", async (request, reply) => {
		const scope = await liveHelpScope(db, config, request, reply, { live: false });
		if (!scope) return reply;
		const services = registry.services(scope.workspaceId).map(withoutCommandLine);
		return reply.header("cache-control", "no-store").send({ services });
	});

	app.post(
		"/courses/:courseId/live-help/:sid/preview-grants",
		async (request, reply) => {
			const helper = requireUser(request);
			const scope = await liveHelpScope(db, config, request, reply, { live: false });
			if (!scope) return reply;
			const body = PreviewGrantRequest.safeParse(request.body);
			if (!body.success) {
				return sendError(reply, 400, "VALIDATION_FAILED", "invalid grant request");
			}
			const { port, presentation } = body.data;
			// The helper never starts the workspace (ADR 0063).
			if (scope.workspace.state !== "running") {
				return sendError(
					reply,
					409,
					"WORKSPACE_NOT_RUNNING",
					"The workspace is stopped",
				);
			}
			if (!portAllowed(config, port)) {
				return sendError(
					reply,
					403,
					"PREVIEW_PORT_NOT_ALLOWED",
					`Port ${port} cannot be previewed`,
				);
			}
			if (!check(grants, helper.id).allowed) {
				return sendError(
					reply,
					429,
					"PREVIEW_RATE_LIMITED",
					"Too many previews were opened just now. Wait a moment.",
				);
			}

			const service = registry.service(scope.workspaceId, port);
			if (service && service.previewReachability === "unknown") {
				try {
					await registry.ensureReachable(scope.workspaceId, port);
				} catch (error) {
					request.log.warn(
						{
							workspaceId: scope.workspaceId,
							port,
							code: error instanceof AgentCallError ? error.code : "INTERNAL",
						},
						"loopback forward could not be opened",
					);
					return sendError(
						reply,
						409,
						"PREVIEW_FORWARD_FAILED",
						`Portikus could not reach port ${port} inside the workspace.`,
					);
				}
			}

			const token = request.sessionToken;
			if (!token) throw new Error("preview grant reached without a session");
			const host = previewHost(scope.workspace.label, port, config.PREVIEW_SUFFIX);
			const { ticket, expiresAt } = await createGrant(db, {
				userId: helper.id,
				sessionId: hashSessionToken(token),
				workspaceId: scope.workspaceId,
				port,
				previewHost: host,
				presentation,
				ttlSeconds: config.PREVIEW_TICKET_TTL_SECONDS,
				liveHelpSessionId: scope.sessionId,
			});
			// Ids and the port only (ADR 0012).
			await recordAudit(db, {
				actor: `user:${helper.id}`,
				target: scope.projectId,
				action: "project.live_help_preview_opened",
				result: "ok",
				metadata: { sessionId: scope.sessionId, port },
			});

			const payload = grantResponse(config, host, ticket, expiresAt);
			return reply
				.header("cache-control", "no-store")
				.header("referrer-policy", "no-referrer")
				.status(201)
				.send(payload);
		},
	);
}
