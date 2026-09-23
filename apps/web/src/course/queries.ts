import { CourseMembersResponse, CoursesResponse } from "@portikus/contracts";
import { useQuery } from "@tanstack/react-query";
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
	});
}
