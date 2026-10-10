import {
	AgentUsageResponse,
	type AgentUsageWindow,
	CourseMembersResponse,
	CoursesResponse,
	RosterSyncResponse,
} from "@portikus/contracts";
import {
	keepPreviousData,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { z } from "zod";
import { request } from "../api/request.js";

/** The courses the caller teaches; empty for everyone else. */
export function useCourses() {
	return useQuery({
		queryKey: ["courses"],
		queryFn: () => request(CoursesResponse, "/courses"),
	});
}

export function useCourseMembers(courseId: string) {
	return useQuery({
		queryKey: ["courses", courseId, "members"],
		queryFn: () => request(CourseMembersResponse, `/courses/${courseId}/members`),
		// Instructors switch tabs a lot; a read-only roster need not refetch each time.
		refetchOnWindowFocus: false,
	});
}

/** Asks the learning system for the member list; the roster and the member rows refresh after. */
export function useSyncRoster(courseId: string) {
	const client = useQueryClient();
	return useMutation({
		mutationFn: () =>
			request(RosterSyncResponse, `/courses/${courseId}/roster/sync`, {
				method: "POST",
			}),
		onSuccess: (sync) => {
			client.setQueryData<CourseMembersResponse>(
				["courses", courseId, "members"],
				(old) => old && { ...old, roster: sync.roster },
			);
			return client.invalidateQueries({ queryKey: ["courses", courseId, "members"] });
		},
	});
}

/** Coding-agent totals for the course's members over the last `days` days. */
export function useCourseAgentUsage(courseId: string, days: AgentUsageWindow) {
	return useQuery({
		queryKey: ["courses", courseId, "agent-usage", days],
		queryFn: () =>
			request(AgentUsageResponse, `/courses/${courseId}/agent-usage?days=${days}`),
		placeholderData: keepPreviousData,
		refetchOnWindowFocus: false,
	});
}

/** Removes one member; the row leaves the cached roster at once. */
export function useRemoveMember(courseId: string) {
	const client = useQueryClient();
	return useMutation({
		mutationFn: (userId: string) =>
			request(z.unknown(), `/courses/${courseId}/members/${userId}/remove`, {
				method: "POST",
			}),
		onSuccess: (_body, userId) => {
			client.setQueryData<CourseMembersResponse>(
				["courses", courseId, "members"],
				(old) =>
					old && {
						...old,
						members: old.members.filter((member) => member.userId !== userId),
					},
			);
		},
	});
}
