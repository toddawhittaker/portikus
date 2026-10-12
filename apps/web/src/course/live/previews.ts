/**
 * What is listening in the student's workspace, and opening one of those
 * services as a preview in a new tab, for the session's helper (ADR 0063).
 * The listing is the student's Running list with less in it: the API drops
 * command lines and process ids, so every field but the port may be missing.
 */
import {
	ListeningService,
	type PreviewGrantRequest,
	PreviewGrantResponse,
} from "@portikus/contracts";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { request, sendJson } from "../../api/request.js";
import { LIVE_POLL_MS, type LiveRef, liveBase } from "./queries.js";

/** One listener as the helper sees it. */
export const LiveListening = z.object({
	port: ListeningService.shape.port,
	previewReachability: ListeningService.shape.previewReachability.optional(),
	system: z.boolean().default(false),
	process: z.object({ command: z.string().optional() }).optional(),
	container: z.object({ name: z.string().optional() }).optional(),
});
export type LiveListening = z.infer<typeof LiveListening>;

/** Response body for `GET /courses/:courseId/live-help/:sid/listening`. */
const LiveListeningResponse = z.object({ services: z.array(LiveListening) });

/** The services worth offering: the student's own, that a preview can reach. */
export function previewable(services: readonly LiveListening[]): LiveListening[] {
	return services
		.filter((service) => !service.system && service.previewReachability !== "denied")
		.sort((a, b) => a.port - b.port);
}

/** A short name for what is listening, when the API says one. */
export function serviceLabel(service: LiveListening): string | undefined {
	return service.container?.name || service.process?.command || undefined;
}

export function useLiveListening(ref: LiveRef, enabled: boolean) {
	return useQuery({
		queryKey: ["courses", ref.courseId, "live-help", ref.sessionId, "listening"],
		queryFn: () => request(LiveListeningResponse, `${liveBase(ref)}/listening`),
		select: (body) => previewable(body.services),
		refetchInterval: LIVE_POLL_MS,
		enabled,
	});
}

/**
 * Open one port's preview in a new tab. The blank tab is opened inside the
 * click, because a browser blocks a window opened after an await, and its
 * opener is cut so the student's code cannot reach this page. Returns false
 * when the grant failed and the caller should say so.
 */
export async function openLivePreview(ref: LiveRef, port: number): Promise<boolean> {
	const opened = window.open("about:blank", "_blank");
	if (opened) opened.opener = null;
	try {
		const body: PreviewGrantRequest = { port, presentation: "top-level" };
		const grant = await sendJson(
			PreviewGrantResponse,
			`${liveBase(ref)}/preview-grants`,
			body,
		);
		if (opened) opened.location.replace(grant.bootstrapUrl);
		else window.open(grant.bootstrapUrl, "_blank", "noopener,noreferrer");
		return true;
	} catch {
		opened?.close();
		return false;
	}
}
