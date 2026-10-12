import { requireUser } from "@portikus/auth";
import { type ListeningService, PreviewGrantRequest } from "@portikus/contracts";
import { recordAudit } from "@portikus/db";
import type { FastifyInstance } from "fastify";
import type { ServerDeps } from "../deps.js";
import { sendError } from "../http.js";
import { liveHelpScope } from "../live-help/gate.js";
import {
	issuePreviewGrant,
	type PreviewRequestLimit,
	sendPreviewGrant,
} from "../preview/grants.js";
import type { ListeningRegistry } from "../preview/registry.js";

/**
 * A listener as the helper sees it: the port and how to reach it, nothing
 * about the processes or containers behind it, whose names and arguments
 * can say more about the student's machine than the helper needs.
 */
function forHelper(service: ListeningService): ListeningService {
	const { process: _process, container: _container, ...rest } = service;
	return rest;
}

/**
 * The helper's previews of the student's workspace during live help, in view
 * and type mode alike (ADR 0063). Both routes go through `liveHelpScope`; the
 * grant is tied to the session, so the preview gateway lets it in only while
 * that session is open.
 */
export function registerCourseLiveHelpPreviewRoutes(
	app: FastifyInstance,
	deps: ServerDeps & {
		registry: ListeningRegistry;
		overPreviewLimit: PreviewRequestLimit;
	},
): void {
	const { db, config, registry } = deps;

	app.get("/courses/:courseId/live-help/:sid/listening", async (request, reply) => {
		const scope = await liveHelpScope(db, config, request, reply, { live: false });
		if (!scope) return reply;
		const services = registry.services(scope.workspaceId).map(forHelper);
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
			// The helper never starts the workspace (ADR 0063).
			const payload = await issuePreviewGrant(deps, request, reply, {
				userId: helper.id,
				workspace: scope.workspace,
				port: body.data.port,
				presentation: body.data.presentation,
				stoppedMessage: "The workspace is stopped",
				liveHelpSessionId: scope.sessionId,
			});
			if (!payload) return reply;
			// Ids and the port only (ADR 0012).
			await recordAudit(db, {
				actor: `user:${helper.id}`,
				target: scope.projectId,
				action: "project.live_help_preview_opened",
				result: "ok",
				metadata: { sessionId: scope.sessionId, port: body.data.port },
			});
			return sendPreviewGrant(reply, payload);
		},
	);
}
