/**
 * Asking a student's application whether it allows being framed
 * (BROWSER-HANDLING.md §12).
 *
 * A student application may send `X-Frame-Options` or a CSP
 * `frame-ancestors` directive that refuses framing. Portikus must preserve
 * that policy and offer "Open in new tab" instead — but the Portikus page
 * cannot tell that the refusal happened: Chromium fires the iframe's `load`
 * event for a navigation it refused, and the parent may not read the frame's
 * response headers. So the control plane asks once, on the student's behalf.
 *
 * This is the one place where the API speaks HTTP to a student application.
 * Two rules keep it safe:
 *
 *  - The address comes from the listening registry and the workspace row,
 *    exactly as `/preview/authorize` takes it, and never from anything the
 *    request carries. A caller chooses a workspace and a port, not a host, so
 *    there is no server-side request forgery to be had: the only reachable
 *    targets are ports the caller's own workspace is already listening on and
 *    that preview policy allows.
 *  - Nothing from the answer but the two framing headers is looked at or
 *    returned, with one narrow exception: when the application answers 403,
 *    the first few kilobytes are matched against the fixed sentences Vite
 *    and webpack-dev-server use to refuse an unknown `Host` (issue #262).
 *    Only which of those sentences matched leaves this file; no application
 *    content is returned, stored, or logged.
 */

import { request as httpRequest } from "node:http";

/** How long the application has to answer before it counts as unreachable. */
const PROBE_TIMEOUT_MS = 3_000;

/**
 * How much of a refused answer is read while looking for a development
 * server's "this host is not allowed" message (issue #262). Nothing read
 * here is returned or logged; only the match is.
 */
export const MAX_REFUSAL_BODY_BYTES = 4_096;

export type EmbeddableReason =
	| "x-frame-options"
	| "frame-ancestors"
	| "unreachable"
	| "host-refused";

/** A development server whose refusal of the preview host is recognised. */
export type RefusingServer = "vite" | "webpack-dev-server";

export interface EmbeddableVerdict {
	embeddable: boolean;
	reason?: EmbeddableReason;
	/** The preview host the development server refused. */
	refusedHost?: string;
	/** Which server refused it, so the tab can show the right setting. */
	refusedServer?: RefusingServer;
}

/**
 * The refusals this code recognises.
 *
 * Vite (5.4.12 and later) and webpack-dev-server check the `Host` header
 * against an allow-list and answer 403 with a fixed sentence. Next.js has no
 * equivalent refusal to match: its `allowedDevOrigins` setting warns about
 * cross-origin requests rather than refusing the host with a 403, so it is
 * deliberately not in this table.
 */
const HOST_REFUSALS: { server: RefusingServer; pattern: RegExp }[] = [
	// The exact sentence only. A bare mention of `server.allowedHosts` is not
	// a refusal: a student's own page, a tutorial or an error trace may carry
	// those words and must not be read as one.
	{ server: "vite", pattern: /blocked request\.[\s\S]{0,200}?is not allowed/i },
	{ server: "webpack-dev-server", pattern: /invalid host(\/origin)? header/i },
];

/**
 * Which development server refused the preview host, if the answer says so.
 *
 * Only a 403 counts: these servers refuse an unknown host with that status,
 * and a page that merely mentions the words is not a refusal.
 */
export function hostRefusalFrom(status: number, body: string): RefusingServer | null {
	if (status !== 403) return null;
	for (const { server, pattern } of HOST_REFUSALS) {
		if (pattern.test(body)) return server;
	}
	return null;
}

/**
 * Decide from an application's headers whether it may be framed by the
 * Portikus page at `portikusOrigin`.
 *
 * `SAMEORIGIN` counts as a refusal: the preview runs on its own host, so the
 * Portikus page is never the application's own origin.
 */
export function verdictFromHeaders(
	headers: Headers,
	portikusOrigin: string,
): EmbeddableVerdict {
	// Several X-Frame-Options headers arrive joined with commas. Any part
	// that refuses framing refuses it for the whole answer.
	const xfo = headers.get("x-frame-options");
	if (xfo) {
		for (const part of xfo.split(",")) {
			const value = part.trim().toLowerCase();
			if (value === "deny" || value === "sameorigin") {
				return { embeddable: false, reason: "x-frame-options" };
			}
		}
	}

	for (const sources of frameAncestors(headers.get("content-security-policy"))) {
		if (!ancestorsAllow(sources, portikusOrigin)) {
			return { embeddable: false, reason: "frame-ancestors" };
		}
	}

	return { embeddable: true };
}

/**
 * Every `frame-ancestors` source list a CSP header carries.
 *
 * One header line may hold several policies separated by semicolons, and
 * several headers arrive joined with commas. A CSP source list never contains
 * a comma, so splitting on both characters gives one directive per piece.
 * Every policy applies at once, so every list found must allow us.
 */
function frameAncestors(header: string | null): string[][] {
	if (!header) return [];
	const found: string[][] = [];
	for (const directive of header.split(/[;,]/)) {
		const parts = directive.trim().split(/\s+/).filter(Boolean);
		if (parts[0]?.toLowerCase() !== "frame-ancestors") continue;
		found.push(parts.slice(1).map((source) => source.toLowerCase()));
	}
	return found;
}

/** Whether a `frame-ancestors` source list lets `portikusOrigin` frame us. */
function ancestorsAllow(sources: string[], portikusOrigin: string): boolean {
	if (sources.length === 0) return false;
	const wanted = new URL(portikusOrigin);
	for (const source of sources) {
		if (source === "'none'") return false;
		if (source === "*") return true;
		// Only exact origins are honoured. Scheme and wildcard-host sources are
		// treated as a refusal, which shows the student the overlay and the
		// "Open in new tab" button rather than a blank frame.
		if (!source.includes("://")) continue;
		try {
			const allowed = new URL(source);
			if (allowed.protocol === wanted.protocol && allowed.host === wanted.host) {
				return true;
			}
		} catch {
			// An unparseable source allows nothing.
		}
	}
	return false;
}

/** One answer from the application: its status, headers, and start of body. */
interface ProbeAnswer {
	status: number;
	headers: Headers;
	/** At most MAX_REFUSAL_BODY_BYTES, and only when the caller asked. */
	body: string;
}

/**
 * Ask the application once.
 *
 * `node:http` rather than `fetch`, because the request must present the
 * preview host: a development server that checks `Host` only refuses the
 * name the student's browser would use, and `fetch` ignores a `host` header.
 */
function ask(
	upstream: string,
	method: "HEAD" | "GET",
	hostHeader: string,
	/** Read the start of the body only for statuses this says yes to. */
	wantBody: (status: number) => boolean,
	signal: AbortSignal,
): Promise<ProbeAnswer> {
	const separator = upstream.lastIndexOf(":");
	const hostname = upstream.slice(0, separator);
	const port = Number(upstream.slice(separator + 1));
	return new Promise((resolve, reject) => {
		// The answer settles once, whether that is the end of the body, the
		// cap being reached, or a socket error.
		let settled = false;
		const settle = (answer: ProbeAnswer) => {
			if (settled) return;
			settled = true;
			resolve(answer);
		};
		const fail = (error: Error) => {
			if (settled) return;
			settled = true;
			reject(error);
		};
		const outbound = httpRequest(
			{
				host: hostname,
				port,
				path: "/",
				method,
				signal,
				headers: { host: hostHeader },
			},
			(response) => {
				const headers = new Headers();
				for (const [name, value] of Object.entries(response.headers)) {
					if (typeof value === "string") headers.append(name, value);
					else if (Array.isArray(value))
						for (const one of value) headers.append(name, one);
				}
				const status = response.statusCode ?? 0;
				let body = "";
				if (!wantBody(status)) {
					response.resume();
					settle({ status, headers, body });
					return;
				}
				response.setEncoding("utf8");
				response.on("data", (chunk: string) => {
					if (settled) return;
					body += chunk.slice(0, MAX_REFUSAL_BODY_BYTES - body.length);
					if (body.length < MAX_REFUSAL_BODY_BYTES) return;
					// Enough to recognise a refusal. The rest of the student's
					// page never enters this process: the connection goes now.
					response.destroy();
					settle({ status, headers, body });
				});
				response.on("end", () => settle({ status, headers, body }));
				response.on("error", fail);
			},
		);
		outbound.on("error", fail);
		outbound.end();
	});
}

/**
 * Ask one application whether it allows framing. `upstream` is a
 * `host:port` the registry vouched for, and `previewHost` the public name
 * the student's browser would use. Both are required: a development server
 * that checks `Host` refuses only the public name, so falling back to the
 * upstream address would quietly stop recognising the refusal.
 *
 * `HEAD /` first, because it costs the application least; an application
 * that refuses HEAD gets one `GET /`. The body of that answer is read only
 * when the status is 403, only up to MAX_REFUSAL_BODY_BYTES, and only to see
 * whether a development server is refusing the preview host (issue #262).
 * No part of it is returned, stored, or logged.
 */
export async function probeEmbeddable(
	upstream: string,
	portikusOrigin: string,
	previewHost: string,
): Promise<EmbeddableVerdict> {
	const hostHeader = previewHost;
	// One budget for both attempts, so a slow application cannot hold the
	// route for twice the timeout.
	const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
	try {
		const refused = (status: number) => status === 403;
		let answer = await ask(upstream, "HEAD", hostHeader, () => false, signal);
		if (answer.status >= 400) {
			// An application that will not answer HEAD gets one GET instead.
			answer = await ask(upstream, "GET", hostHeader, refused, signal);
		}
		const server = hostRefusalFrom(answer.status, answer.body);
		if (server) {
			return {
				embeddable: false,
				reason: "host-refused",
				refusedHost: hostHeader,
				refusedServer: server,
			};
		}
		return verdictFromHeaders(answer.headers, portikusOrigin);
	} catch {
		return { embeddable: false, reason: "unreachable" };
	}
}
