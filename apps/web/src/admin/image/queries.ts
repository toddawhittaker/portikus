import {
	AdminImage,
	ImageDiff,
	ImageJobDetail,
	type ImageJobRequest,
	type ImageJobState,
	ImageJobView,
} from "@portikus/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { request, sendJson } from "../../api/request.js";

export const imageKey = ["admin", "image"] as const;

/** The page polls a queued or running job every two seconds (docs/SPEC.md section 22.4). */
export const IMAGE_POLL_MS = 2000;

export function isActive(state: ImageJobState | undefined): boolean {
	return state === "queued" || state === "running";
}

/** The images, their roles and the current job; polled while a job is active. */
export function useAdminImage() {
	return useQuery({
		queryKey: imageKey,
		queryFn: () => request(AdminImage, "/admin/image"),
		refetchInterval: (query) =>
			isActive(query.state.data?.job?.state) ? IMAGE_POLL_MS : false,
		retry: false,
	});
}

/** One job's status and the tail of its log. */
export function useImageJob(id: string | null) {
	return useQuery({
		queryKey: [...imageKey, "job", id],
		queryFn: () =>
			request(ImageJobDetail, `/admin/image/jobs/${encodeURIComponent(id ?? "")}`),
		enabled: id !== null,
		refetchInterval: (query) =>
			isActive(query.state.data?.job.state) ? IMAGE_POLL_MS : false,
	});
}

/** What `to` changes against `from`; null skips the request. */
export function useImageDiff(from: string | null, to: string | null) {
	return useQuery({
		queryKey: [...imageKey, "diff", from, to],
		queryFn: () =>
			request(
				ImageDiff,
				`/admin/image/diff?from=${encodeURIComponent(from ?? "")}&to=${encodeURIComponent(to ?? "")}`,
			),
		enabled: from !== null && to !== null,
	});
}

export function useRequestImageJob() {
	const client = useQueryClient();
	return useMutation({
		mutationFn: (body: ImageJobRequest) =>
			sendJson(ImageJobView, "/admin/image/jobs", body),
		// Waiting for the refetch lets a confirm dialog return focus to the new job heading.
		onSuccess: () => client.invalidateQueries({ queryKey: imageKey }),
	});
}
