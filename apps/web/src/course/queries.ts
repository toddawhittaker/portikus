import { CourseMembersResponse, CoursesResponse } from "@portikus/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { request } from "../api/request.js";

/** The courses the caller teaches; empty for everyone else (Epic 13 ruling 23). */
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
