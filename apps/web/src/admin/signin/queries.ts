import {
	AdminSignin,
	isJobActive,
	SITE_JOB_STALE_MS,
	type SigninSettings,
	SiteJobView,
} from "@portikus/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { request, sendJson } from "../../api/request.js";

const signinKey = ["admin", "signin"] as const;

/** Where the browser goes to start a test sign-in; it comes back to the Sign-in tab. */
export const TEST_SIGNIN_URL = "/admin/signin/test";

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
