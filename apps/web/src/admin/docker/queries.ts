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
import { z } from "zod";
import { request, sendJson, toApiError } from "../../api/request.js";

export const dockerKey = ["admin", "docker"] as const;
const jobsKey = [...dockerKey, "seed-jobs"] as const;
const usageKey = [...dockerKey, "usage"] as const;

/** The cache's helper writes its status once a minute, so the page rereads it. */
const DOCKER_POLL_MS = 15_000;
/** A queued or running seed rebuild is polled every two seconds, like image jobs. */
const SEED_JOB_POLL_MS = 2000;

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
	// Each card sends only its own field.
	return useDockerWrite((body: Partial<DockerSettingsRequest>) =>
		sendJson(z.undefined(), "/admin/docker/settings", body, "PUT"),
	);
}

export function useSetHubCredential() {
	return useDockerWrite((body: HubCredentialRequest) =>
		sendJson(z.undefined(), "/admin/docker/hub-credential", body, "PUT"),
	);
}

export function useRemoveHubCredential() {
	return useDockerWrite<void>(() =>
		request(z.undefined(), "/admin/docker/hub-credential", { method: "DELETE" }),
	);
}

export function useClearCache() {
	// A 202 with no body, which `request` would try to parse.
	return useDockerWrite<void>(async () => {
		const response = await fetch("/admin/docker/cache/clear", {
			method: "POST",
			credentials: "same-origin",
		});
		if (!response.ok) throw await toApiError(response);
	});
}

export function useSaveSeedImages() {
	return useDockerWrite((images: string[]) =>
		sendJson(z.undefined(), "/admin/docker/seed/images", { images }, "PUT"),
	);
}

/** Swap the list's matched images for the default image's and rebuild. */
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
