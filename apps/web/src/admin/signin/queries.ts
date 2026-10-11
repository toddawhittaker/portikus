import {
	AdminSignin,
	isJobActive,
	SITE_JOB_STALE_MS,
	type SigninSettings,
	SiteJobView,
} from "@portikus/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { request, sendJson } from "../../api/request.js";

const signinKey = ["admin", "signin"] as const;

/** The browser is sent here, so only https is accepted; plain http only on loopback, where development and e2e run their mock provider. */
function isSafeProviderUrl(value: string): boolean {
	if (!URL.canParse(value)) return false;
	const url = new URL(value);
	if (url.protocol === "https:") return true;
	return url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname);
}

export const TestSigninStart = z.object({
	location: z.string().url().refine(isSafeProviderUrl, "must be an https URL"),
});

/** Start a test sign-in; the caller sends the browser to the returned address, and it comes back to the Sign-in tab. */
export function useStartTestSignin() {
	return useMutation({
		mutationFn: () =>
			request(TestSigninStart, "/admin/signin/test", { method: "POST" }),
	});
}

/** A waiting or running job is polled every two seconds, as the certificate page does. */
const ACTIVE_POLL_MS = 2000;
/** An open trial is polled more slowly, to see it kept, rolled back or expired. */
const TRIAL_POLL_MS = 15_000;

/** The provider in force, the current job and the newest test sign-in. */
export function useAdminSignin() {
	return useQuery({
		queryKey: signinKey,
		queryFn: () => request(AdminSignin, "/admin/signin"),
		refetchInterval: (query) => {
			const job = query.state.data?.job;
			if (isJobActive(job, SITE_JOB_STALE_MS)) return ACTIVE_POLL_MS;
			return job?.state === "trial" ? TRIAL_POLL_MS : false;
		},
		retry: false,
	});
}

/** The body may hold the client secret: gcTime 0 and the caller's reset drop it once sent. */
export function useApplySignin() {
	const client = useQueryClient();
	return useMutation({
		gcTime: 0,
		mutationFn: (body: SigninSettings) => sendJson(SiteJobView, "/admin/signin", body),
		onSuccess: () => client.invalidateQueries({ queryKey: signinKey }),
	});
}

/** Keep or roll back the open trial. */
export function useEndTrial() {
	const client = useQueryClient();
	return useMutation({
		mutationFn: ({
			action,
			trialId,
		}: {
			action: "keep" | "rollback";
			trialId: string;
		}) => sendJson(SiteJobView, `/admin/signin/${action}`, { trialId }),
		onSuccess: () => client.invalidateQueries({ queryKey: signinKey }),
	});
}
