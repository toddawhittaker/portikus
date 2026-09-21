/**
 * Asking the control plane for a preview grant (BROWSER-HANDLING.md §9.1).
 *
 * The browser never builds a preview URL itself: the API works out the
 * preview host, mints a single-use bootstrap ticket, and hands back both.
 * Everything a Preview tab loads comes from one of those two values.
 */
import { PreviewEmbeddableResponse, PreviewGrantResponse } from "@portikus/contracts";
import { z } from "zod";
import { request } from "../api/request.js";

export type Grant = PreviewGrantResponse;

export { MIN_PREVIEW_PORT } from "../links.js";

export async function requestGrant(
	workspaceId: string,
	port: number,
	presentation: "embedded" | "top-level",
): Promise<Grant> {
	return request(PreviewGrantResponse, `/workspaces/${workspaceId}/preview-grants`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ port, presentation }),
	});
}

/**
 * Ask the control plane whether the application on this port allows being
 * framed (BROWSER-HANDLING.md §12).
 *
 * The page cannot work this out itself: Chromium fires the frame's `load`
 * event even for a navigation it refused, and a parent may not read the
 * frame's response headers. So the API asks the application once and reports
 * only the verdict.
 */
export async function probeEmbeddable(
	workspaceId: string,
	port: number,
): Promise<PreviewEmbeddableResponse> {
	return request(
		PreviewEmbeddableResponse,
		`/workspaces/${workspaceId}/preview/embeddable?port=${port}`,
	);
}

/** Revoke this workspace's preview sessions (BROWSER-HANDLING.md §9.2). */
export async function resetPreviewData(workspaceId: string): Promise<void> {
	await request(z.unknown(), `/workspaces/${workspaceId}/preview/reset`, {
		method: "POST",
	});
}

/**
 * Ask the preview origin to clear the browser data it holds
 * (BROWSER-HANDLING.md §16.4).
 *
 * This runs from the Portikus page, not from inside the preview frame. An
 * application may register a service worker whose scope covers the whole
 * preview origin, and such a worker answers navigations made by pages it
 * controls — so navigating the frame to a reserved path could be answered
 * by the application instead of by the edge. This document is not a client
 * of that worker, so the request goes to the network, reaches the edge, and
 * comes back with the `Clear-Site-Data` header that drops the origin's
 * cookies, storage and service worker registrations.
 *
 * The response is opaque (`no-cors`), which is fine: nothing is read from
 * it. Only its headers matter, and the browser applies those itself.
 */
export async function clearPreviewOriginData(previewOrigin: string): Promise<void> {
	await fetch(`${previewOrigin}/__portikus/reset`, {
		mode: "no-cors",
		credentials: "include",
		cache: "no-store",
	});
}
