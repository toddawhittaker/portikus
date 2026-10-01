import {
	AdminCertificate,
	CertificateJobDetail,
	type CertificateJobRequest,
	type CertificateJobState,
	CertificateJobView,
	CertificatePreflight,
} from "@portikus/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { request } from "../../api/request.js";

export const certificateKey = ["admin", "certificate"] as const;

/** The admin download of Caddy's internal root certificate (Epic 27 R13). */
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

/** One job's status and the tail of its log. */
export function useCertificateJob(id: string) {
	return useQuery({
		queryKey: [...certificateKey, "job", id],
		queryFn: () =>
			request(
				CertificateJobDetail,
				`/admin/certificate/jobs/${encodeURIComponent(id)}`,
			),
		refetchInterval: (query) =>
			isActive(query.state.data?.job.state) ? CERTIFICATE_POLL_MS : false,
	});
}

/** Whether the names point here, before an ACME test or apply (Epic 27 R10). */
export function usePreflight() {
	return useMutation({
		mutationFn: (mode: "dns01" | "http01") =>
			request(CertificatePreflight, "/admin/certificate/preflight", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ mode }),
			}),
	});
}

export function useRequestCertificateJob() {
	const client = useQueryClient();
	return useMutation({
		mutationFn: (body: CertificateJobRequest) =>
			request(CertificateJobView, "/admin/certificate/jobs", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			}),
		onSuccess: () => client.invalidateQueries({ queryKey: certificateKey }),
	});
}
