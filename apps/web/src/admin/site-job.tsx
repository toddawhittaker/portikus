import { isJobActive, SITE_JOB_STALE_MS, type SiteJobView } from "@portikus/contracts";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { ZodType } from "zod";
import { request } from "../api/request.js";
import { Notice } from "./Notice.js";

/** A queued or running job is polled every two seconds, as the certificate page does. */
const POLL_MS = 2000;

/**
 * One site page's data and the job it follows (ADR 0059). The page follows
 * the job it asked for, because the API may report an older dead job until
 * the new one is taken.
 */
export function useSiteList<T extends { job: SiteJobView | null }>(
	key: string,
	path: string,
	schema: ZodType<T>,
) {
	const [requested, setRequested] = useState<SiteJobView | null>(null);
	const waiting = requested !== null && isJobActive(requested, SITE_JOB_STALE_MS);
	const query = useQuery({
		queryKey: ["admin", key],
		queryFn: () => request(schema, path),
		refetchInterval: (q) =>
			waiting || isJobActive(q.state.data?.job, SITE_JOB_STALE_MS) ? POLL_MS : false,
		retry: false,
	});
	const reported = query.data?.job ?? null;
	if (requested && reported?.id === requested.id) setRequested(null);
	const job = waiting ? requested : reported;
	return {
		query,
		job,
		busy: isJobActive(job, SITE_JOB_STALE_MS),
		follow: setRequested,
	};
}

function failureText(job: SiteJobView): string {
	switch (job.code) {
		case "proxy_config_rejected":
			return "The proxy refused the change, so nothing was changed.";
		case "proxy_reload_failed":
			return "The proxy could not reload, so the old settings were put back.";
		case "api_restart_failed":
			return "The change was saved, but the API did not restart. Restart it from the server.";
		case "operator_platform":
			return "The operator's file already registers that platform, so nothing was changed.";
		case "invalid_value":
		case "invalid_request":
		case "too_many":
		case "duplicate":
			return "The server did not accept a value, so nothing was changed.";
		default:
			return "The change was not applied. Nothing was changed.";
	}
}

/** One line on the latest save, for a status region. */
export function SiteJobLine({ job }: { job: SiteJobView | null }) {
	if (!job) return null;
	if (isJobActive(job, SITE_JOB_STALE_MS)) {
		return (
			<Notice tone="pending">
				{job.state === "queued"
					? "Saving. Waiting for the server to apply the change."
					: "Saving. The server is applying the change."}
			</Notice>
		);
	}
	if (job.state === "done") {
		return <p className="pk-text-compact pk-muted m-0">Saved. The change is in use.</p>;
	}
	if (job.state === "failed") return <Notice tone="error">{failureText(job)}</Notice>;
	if (job.state === "queued" || job.state === "running") {
		return (
			<Notice tone="warning">
				The last change did not finish, so it may not be in use. Save again. If it stops
				again, look for portikus-site-job in the server's journal.
			</Notice>
		);
	}
	return null;
}
