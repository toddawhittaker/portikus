import { signDeepLinkingResponse } from "@portikus/auth";
import { recordAudit } from "@portikus/db";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ServerDeps } from "../deps.js";
import { sendError } from "../http.js";
import {
	deepLinkPage,
	expiredPage,
	findDeepLinkRequest,
	type PickerValues,
	pickerPage,
	returnPage,
	takeDeepLinkRequest,
	templateChoice,
} from "../lti/deep-link.js";
import { parseStarterChoice, starterCustomParameters } from "../lti/starter.js";
import { requestMetadata } from "../sessions/start-session.js";
import { toolJwks } from "./lti.js";

/** The CSP of a picker or return page; a form may post only to `formAction`. */
function cspFor(formAction: string): string {
	return [
		"default-src 'none'",
		"style-src 'unsafe-inline'",
		`form-action ${formAction}`,
		"base-uri 'none'",
		"frame-ancestors 'none'",
	].join("; ");
}

/** What the picker form chose, read as a starter choice's input. */
function choiceInput(values: PickerValues): {
	projectName: string;
	template?: string;
	repositoryUrl?: string;
} {
	const prefix = templateChoice("");
	if (values.choice.startsWith(prefix)) {
		return {
			projectName: values.projectName,
			template: values.choice.slice(prefix.length),
		};
	}
	if (values.choice === "repository") {
		return { projectName: values.projectName, repositoryUrl: values.repositoryUrl };
	}
	return { projectName: values.projectName };
}

/**
 * The Deep Linking picker's submit (ADR 0058, SPEC.md §24): sign the
 * response for the stored request and hand it back through a button.
 * The return URL is only ever the one the platform signed.
 */
export function registerLtiDeepLinkRoutes(
	app: FastifyInstance,
	{ db, config, lti }: ServerDeps,
): void {
	function html(reply: FastifyReply, status: number, body: string) {
		return reply
			.status(status)
			.header("cache-control", "no-store")
			.type("text/html; charset=utf-8")
			.send(body);
	}

	app.post("/lti/deep-link", async (request, reply) => {
		reply.header("content-security-policy", cspFor("'self'"));
		if (!lti) return sendError(reply, 404, "NOT_FOUND", "Not found.");
		const form = (request.body ?? {}) as Record<string, unknown>;
		const field = (name: string) => {
			const value = form[name];
			return typeof value === "string" ? value : "";
		};
		const handle = field("handle");
		const expired = () => {
			request.log.info({ reason: "deep_link_expired" }, "lti deep link refused");
			return html(reply, 400, expiredPage());
		};

		const pending = handle === "" ? undefined : await findDeepLinkRequest(db, handle);
		if (!pending) return expired();
		// Platforms are read now, so a registration removed meanwhile is honoured.
		const platform = lti.platforms.find(
			(p) => p.issuer === pending.platform_issuer && p.clientId === pending.client_id,
		);
		if (!platform) return expired();
		if (!lti.toolKeyPem) {
			request.log.warn({ reason: "no_tool_key" }, "lti deep link refused");
			return html(
				reply,
				503,
				deepLinkPage(
					"Portikus cannot finish this link",
					"<p>Portikus has no tool key to sign the link with. Ask your Portikus administrator.</p>\n",
				),
			);
		}

		const values: PickerValues = {
			choice: field("choice"),
			repositoryUrl: field("repository"),
			projectName: field("project"),
		};
		const choice = parseStarterChoice(choiceInput(values), config.projectTemplates);
		if (typeof choice === "string") {
			return html(
				reply,
				400,
				pickerPage(handle, config.projectTemplates, values, choice),
			);
		}

		// Taking the row makes the handle single use, even against a second submit.
		const taken = await takeDeepLinkRequest(db, handle);
		if (!taken) return expired();
		const kid = toolJwks(lti.toolKeyPem).keys[0]?.kid ?? "";
		const jwt = await signDeepLinkingResponse({
			toolKeyPem: lti.toolKeyPem,
			kid,
			clientId: taken.client_id,
			platformIssuer: taken.platform_issuer,
			deploymentId: taken.deployment_id,
			data: taken.data,
			contentItems: [
				{
					title: choice.projectName,
					url: `${config.PUBLIC_URL}/`,
					custom: starterCustomParameters(choice),
				},
			],
		});

		await recordAudit(db, {
			// The picker has no session, so the actor is the LTI identity, written
			// as users.oidc_issuer and oidc_subject would hold it (SPEC.md §24.11).
			actor: taken.subject
				? `lti:${taken.platform_issuer}|${taken.subject}`
				: "unknown",
			target: "unknown",
			action: "lti.deep_link",
			result: "ok",
			metadata: {
				platform: platform.name,
				...(choice.template !== null
					? { source: "template", template: choice.template }
					: {
							source: "repository",
							repositoryHost: new URL(choice.repositoryUrl).host,
						}),
				...requestMetadata(request),
			},
		});
		request.log.info("lti deep link signed");
		reply.header("content-security-policy", cspFor(new URL(taken.return_url).origin));
		return html(reply, 200, returnPage(taken.return_url, jwt, choice.projectName));
	});
}
