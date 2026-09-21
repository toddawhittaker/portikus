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
 *  - Nothing from the answer but these two headers is ever looked at or
 *    returned. The body is discarded without being read, so no application
 *    content can leak through this route.
 */

/** How long the application has to answer before it counts as unreachable. */
const PROBE_TIMEOUT_MS = 3_000;

export type EmbeddableReason = "x-frame-options" | "frame-ancestors" | "unreachable";

export interface EmbeddableVerdict {
	embeddable: boolean;
	reason?: EmbeddableReason;
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
	const xfo = headers.get("x-frame-options");
	if (xfo) {
		const value = xfo.trim().toLowerCase();
		if (value === "deny" || value === "sameorigin") {
			return { embeddable: false, reason: "x-frame-options" };
		}
	}

	const ancestors = frameAncestors(headers.get("content-security-policy"));
	if (ancestors !== null && !ancestorsAllow(ancestors, portikusOrigin)) {
		return { embeddable: false, reason: "frame-ancestors" };
	}

	return { embeddable: true };
}

/**
 * The sources of the first `frame-ancestors` directive in a CSP header, or
 * null when the header has none. A header line may carry several policies
 * separated by semicolons, and several headers may be joined with commas;
 * every policy applies, so the first `frame-ancestors` found is enough to
 * make the application non-embeddable if it does not allow us.
 */
function frameAncestors(header: string | null): string[] | null {
	if (!header) return null;
	for (const policy of header.split(/[;,]/)) {
		const parts = policy.trim().split(/\s+/).filter(Boolean);
		const name = parts[0]?.toLowerCase();
		if (name !== "frame-ancestors") continue;
		return parts.slice(1).map((source) => source.toLowerCase());
	}
	return null;
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

/**
 * Ask one application whether it allows framing. `upstream` is a
 * `host:port` the registry vouched for.
 *
 * `HEAD /` first, because it costs the application least; an application that
 * refuses HEAD gets a `GET /` whose body is discarded unread.
 */
export async function probeEmbeddable(
	upstream: string,
	portikusOrigin: string,
): Promise<EmbeddableVerdict> {
	const url = `http://${upstream}/`;
	try {
		let response = await fetch(url, {
			method: "HEAD",
			redirect: "manual",
			signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
		});
		if (response.status === 405 || response.status === 501) {
			response = await fetch(url, {
				method: "GET",
				redirect: "manual",
				signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
			});
		}
		const verdict = verdictFromHeaders(response.headers, portikusOrigin);
		// Never read the body: only the headers of this answer are used.
		await response.body?.cancel();
		return verdict;
	} catch {
		return { embeddable: false, reason: "unreachable" };
	}
}
