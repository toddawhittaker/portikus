import { DEX_PASSWORD_ROUTE } from "@portikus/auth";
import type { FastifyInstance } from "fastify";

/**
 * The content security policy for HTML the API writes itself (SPEC.md
 * section 24.3): no scripts, inline styles only, and never framed.
 */
export const PAGE_POLICY =
	"default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

/** A preview-host page: like PAGE_POLICY, but the Preview tab may frame it. */
export function previewPagePolicy(publicUrl: string): string {
	const origin = new URL(publicUrl).origin;
	return `default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors ${origin}`;
}

/**
 * Adds PAGE_POLICY to any HTML reply that carries no policy of its own. The
 * Dex password relay is skipped: it passes Dex's page back, whose
 * stylesheet, font, logo and inline script this policy would block, and
 * sets the policy on its own pages itself.
 */
export function registerPagePolicy(app: FastifyInstance): void {
	app.addHook("onSend", async (request, reply) => {
		if (request.routeOptions.url === DEX_PASSWORD_ROUTE) return;
		if (reply.hasHeader("content-security-policy")) return;
		const type = reply.getHeader("content-type");
		if (typeof type === "string" && type.toLowerCase().startsWith("text/html")) {
			reply.header("content-security-policy", PAGE_POLICY);
		}
	});
}
