import {
	DockerAdminResponse,
	type DockerSettingsRequest,
	DockerUsageResponse,
	type HubCredentialRequest,
	SeedJob,
	type SeedJobState,
	SeedJobsResponse,
} from "@portikus/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { request, toApiError } from "../../api/request.js";

export const dockerKey = ["admin", "docker"] as const;
const jobsKey = [...dockerKey, "seed-jobs"] as const;
const usageKey = [...dockerKey, "usage"] as const;

/** The cache's helper writes its status once a minute, so the page rereads it. */
export const DOCKER_POLL_MS = 15_000;
/** A queued or running seed rebuild is polled every two seconds, like image jobs. */
export const SEED_JOB_POLL_MS = 2000;

const JSON_HEADERS = { "content-type": "application/json" };

/** A write the API answers with no body (204, or 202 for Clear cache). */
async function send(input: string, init: RequestInit): Promise<void> {
	const response = await fetch(input, { credentials: "same-origin", ...init });
	if (!response.ok) throw await toApiError(response);
}

export function isActive(state: SeedJobState | undefined): boolean {
	return state === "queued" || state === "running";
}

export function useDockerAdmin() {
	return useQuery({
		queryKey: dockerKey,
		queryFn: () => request(DockerAdminResponse, "/admin/docker"),
		refetchInterval: DOCKER_POLL_MS,
		retry: false,
	});
}

export function useSeedJobs() {
	return useQuery({
		queryKey: jobsKey,
		queryFn: () => request(SeedJobsResponse, "/admin/docker/seed/jobs"),
		refetchInterval: (query) =>
			isActive(query.state.data?.jobs[0]?.state) ? SEED_JOB_POLL_MS : false,
	});
}

export function useDockerUsage() {
	return useQuery({
		queryKey: usageKey,
		queryFn: () => request(DockerUsageResponse, "/admin/docker/usage"),
	});
}

/** One write to the Docker routes; every one rereads the tab's data. */
function useDockerWrite<T>(send: (body: T) => Promise<unknown>) {
	const client = useQueryClient();
	return useMutation({
		mutationFn: send,
		onSuccess: () => client.invalidateQueries({ queryKey: dockerKey }),
	});
}

export function useSaveDockerSettings() {
	// Each card sends only its own field (Epic 26 review, Q3).
	return useDockerWrite((body: Partial<DockerSettingsRequest>) =>
		send("/admin/docker/settings", {
			method: "PUT",
			headers: JSON_HEADERS,
			body: JSON.stringify(body),
		}),
	);
}

export function useSetHubCredential() {
	return useDockerWrite((body: HubCredentialRequest) =>
		send("/admin/docker/hub-credential", {
			method: "PUT",
			headers: JSON_HEADERS,
			body: JSON.stringify(body),
		}),
	);
}

export function useRemoveHubCredential() {
	return useDockerWrite<void>(() =>
		send("/admin/docker/hub-credential", { method: "DELETE" }),
	);
}

export function useClearCache() {
	return useDockerWrite<void>(() =>
		send("/admin/docker/cache/clear", { method: "POST" }),
	);
}

export function useSaveSeedImages() {
	return useDockerWrite((images: string[]) =>
		send("/admin/docker/seed/images", {
			method: "PUT",
			headers: JSON_HEADERS,
			body: JSON.stringify({ images }),
		}),
	);
}

/** Swap the list's matched images for the default image's and rebuild (issue #932). */
export function useMatchSeed() {
	return useDockerWrite<void>(() =>
		request(SeedJob, "/admin/docker/seed/match", { method: "POST" }),
	);
}

export function useRebuildSeed() {
	return useDockerWrite<void>(() =>
		request(SeedJob, "/admin/docker/seed/jobs", { method: "POST" }),
	);
}
