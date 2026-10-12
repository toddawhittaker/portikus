import { hashSessionToken } from "@portikus/auth";
import type { ApiConfig } from "@portikus/config";
import {
	type PreviewGrantResponse,
	type PreviewPresentation,
	previewHost,
} from "@portikus/contracts";
import type { Database } from "@portikus/db";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import { AgentCallError } from "../agent-client.js";
import { sendError } from "../http.js";
import { check, createCounter } from "../rate-limit.js";
import {
	grantResponse,
	PREVIEW_REQUESTS_PER_WINDOW,
	PREVIEW_WINDOW_MS,
	portAllowed,
} from "./policy.js";
import type { ListeningRegistry } from "./registry.js";
import { createGrant } from "./store.js";

/** Records one preview request and says whether the user is over the limit. */
export type PreviewRequestLimit = (userId: string) => boolean;

/**
 * One budget per user for every preview request, the student's and an
 * instructor's through live help alike. buildServer makes one and hands it
 * to both grant routes.
 */
export function createPreviewRequestLimit(): PreviewRequestLimit {
	const counter = createCounter(PREVIEW_REQUESTS_PER_WINDOW, PREVIEW_WINDOW_MS);
	return (userId) => !check(counter, userId).allowed;
}

/** The main session's row id, which is the hash of its cookie token. */
function sessionIdOf(request: FastifyRequest): string {
	const token = request.sessionToken;
	if (!token) throw new Error("preview grant reached without a session");
	return hashSessionToken(token);
}

export interface PreviewGrantDeps {
	db: Kysely<Database>;
	config: ApiConfig;
	registry: ListeningRegistry;
	overPreviewLimit: PreviewRequestLimit;
}

/**
 * The checks and the ticket every preview grant shares (BROWSER-HANDLING.md
 * §9.1, §11.1): a running workspace, an allowed port, the rate limit, and a
 * loopback forward when the service needs one. Answers the refusal itself
 * and returns null, or returns the grant for the caller to send.
 */
export async function issuePreviewGrant(
	{ db, config, registry, overPreviewLimit }: PreviewGrantDeps,
	request: FastifyRequest,
	reply: FastifyReply,
	grant: {
		userId: string;
		workspace: { id: string; label: string; state: string };
		port: number;
		presentation: PreviewPresentation;
		/** What a stopped workspace is answered with. */
		stoppedMessage: string;
		liveHelpSessionId?: string;
	},
): Promise<PreviewGrantResponse | null> {
	const { workspace, port } = grant;
	if (workspace.state !== "running") {
		sendError(reply, 409, "WORKSPACE_NOT_RUNNING", grant.stoppedMessage);
		return null;
	}
	if (!portAllowed(config, port)) {
		sendError(
			reply,
			403,
			"PREVIEW_PORT_NOT_ALLOWED",
			`Port ${port} cannot be previewed`,
		);
		return null;
	}
	if (overPreviewLimit(grant.userId)) {
		request.log.warn({ workspaceId: workspace.id }, "preview grant rate limit reached");
		sendError(
			reply,
			429,
			"PREVIEW_RATE_LIMITED",
			"Too many previews were opened just now. Wait a moment.",
		);
		return null;
	}

	// A service bound only to loopback needs the agent's forward before the
	// gateway can reach it (BROWSER-HANDLING.md §11.1).
	const service = registry.service(workspace.id, port);
	if (service && service.previewReachability === "unknown") {
		try {
			await registry.ensureReachable(workspace.id, port);
		} catch (error) {
			request.log.warn(
				{
					workspaceId: workspace.id,
					port,
					code: error instanceof AgentCallError ? error.code : "INTERNAL",
				},
				"loopback forward could not be opened",
			);
			sendError(
				reply,
				409,
				"PREVIEW_FORWARD_FAILED",
				`Portikus could not reach port ${port} inside the ` +
					"workspace. Try again, or bind the application to 0.0.0.0.",
			);
			return null;
		}
	}

	const host = previewHost(workspace.label, port, config.PREVIEW_SUFFIX);
	const { ticket, expiresAt } = await createGrant(db, {
		userId: grant.userId,
		// The plugin gave us a live session, so the token is present.
		sessionId: sessionIdOf(request),
		workspaceId: workspace.id,
		port,
		previewHost: host,
		presentation: grant.presentation,
		ttlSeconds: config.PREVIEW_TICKET_TTL_SECONDS,
		...(grant.liveHelpSessionId ? { liveHelpSessionId: grant.liveHelpSessionId } : {}),
	});
	return grantResponse(config, host, ticket, expiresAt);
}

/** Send a grant: never cached, and its ticket never leaks through a Referer. */
export function sendPreviewGrant(
	reply: FastifyReply,
	payload: PreviewGrantResponse,
): FastifyReply {
	return reply
		.header("cache-control", "no-store")
		.header("referrer-policy", "no-referrer")
		.status(201)
		.send(payload);
}
