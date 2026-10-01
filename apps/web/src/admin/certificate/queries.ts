import {
	AdminCertificate,
	CertificateJobDetail,
	type CertificateJobRequest,
	type CertificateJobState,
	CertificateJobView,
	CertificatePreflight,
} from "@portikus/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { request, sendJson } from "../../api/request.js";

export const certificateKey = ["admin", "certificate"] as const;

/** The admin download of Caddy's internal root certificate. */
export const ROOT_CERTIFICATE_URL = "/admin/certificate/root.crt";

/** The page polls a queued or running job every two seconds, as the image page does. */
export const CERTIFICATE_POLL_MS = 2000;

export function isActive(state: CertificateJobState | undefined): boolean {
	return state === "queued" || state === "running";
}

/** What is in force, the certificate's status and the current job; polled while a job is active. */
export function useAdminCertificate() {
	return useQuery({
		queryKey: certificateKey,
		queryFn: () => request(AdminCertificate, "/admin/certificate"),
		refetchInterval: (query) =>
			isActive(query.state.data?.job?.state) ? CERTIFICATE_POLL_MS : false,
		retry: false,
	});
}

/**
 * One job's status and the tail of its log. Until the first answer arrives,
 * `pageState` (the job's state on the page) decides the polling, so a first
 * 404 does not freeze the log of a job that is still running.
 */
export function useCertificateJob(id: string, pageState: CertificateJobState) {
	return useQuery({
		queryKey: [...certificateKey, "job", id],
		queryFn: () =>
			request(
				CertificateJobDetail,
				`/admin/certificate/jobs/${encodeURIComponent(id)}`,
			),
		refetchInterval: (query) =>
			isActive(query.state.data?.job.state ?? pageState) ? CERTIFICATE_POLL_MS : false,
	});
}

/** Whether the names point here, before an ACME test or apply. */
export function usePreflight() {
	return useMutation({
		mutationFn: (mode: "dns01" | "http01") =>
			sendJson(CertificatePreflight, "/admin/certificate/preflight", { mode }),
	});
}

/** A request may carry secrets: the caller resets it once done, and gcTime 0 drops it from the cache then. */
export function useRequestCertificateJob() {
	const client = useQueryClient();
	return useMutation({
		gcTime: 0,
		mutationFn: (body: CertificateJobRequest) =>
			sendJson(CertificateJobView, "/admin/certificate/jobs", body),
		onSuccess: () => client.invalidateQueries({ queryKey: certificateKey }),
	});
}
