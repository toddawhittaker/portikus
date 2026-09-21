/**
 * Asking the control plane for a preview grant (BROWSER-HANDLING.md §9.1).
 *
 * The browser never builds a preview URL itself: the API works out the
 * preview host, mints a single-use bootstrap ticket, and hands back both.
 * Everything a Preview tab loads comes from one of those two values.
 */
import { PreviewGrantResponse } from "@portikus/contracts";
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

/** Revoke this workspace's preview sessions (BROWSER-HANDLING.md §9.2). */
export async function resetPreviewData(workspaceId: string): Promise<void> {
	await request(z.unknown(), `/workspaces/${workspaceId}/preview/reset`, {
		method: "POST",
	});
}
