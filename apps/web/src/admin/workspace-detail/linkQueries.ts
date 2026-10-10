import { AdminAccountLinks, AdminUserList } from "@portikus/contracts";
import {
	keepPreviousData,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { request } from "../../api/request.js";
import { adminKeys } from "../queries.js";

/** What the search lists for a blank box: the Source column's text for a course account. */
const COURSE_SEARCH = "Course:";

const linksKey = (userId: string) => ["admin", "links", userId] as const;

/** The course accounts linked to one SSO account (ADR 0026). */
export function useAccountLinks(userId: string) {
	return useQuery({
		queryKey: linksKey(userId),
		queryFn: () => request(AdminAccountLinks, `/admin/users/${userId}/links`),
	});
}

/** One page of accounts for the link dialog, found by the server (SPEC.md section 20.1). */
export function useCourseAccountSearch(text: string, enabled: boolean) {
	const q = text.trim() === "" ? COURSE_SEARCH : text.trim();
	const params = new URLSearchParams({ q, limit: "50" });
	return useQuery({
		queryKey: [...adminKeys.users, "link-search", q],
		queryFn: () => request(AdminUserList, `/admin/users?${params.toString()}`),
		enabled,
		placeholderData: keepPreviousData,
	});
}

/** Link or unlink; both refresh the links and the Users list. */
export function useChangeLink(userId: string) {
	const client = useQueryClient();
	return useMutation({
		mutationFn: ({
			courseUserId,
			unlink,
		}: {
			courseUserId: string;
			unlink: boolean;
		}) =>
			unlink
				? request(AdminAccountLinks, `/admin/users/${userId}/links/${courseUserId}`, {
						method: "DELETE",
					})
				: request(AdminAccountLinks, `/admin/users/${userId}/links`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ courseUserId }),
					}),
		onSettled: () => {
			void client.invalidateQueries({ queryKey: ["admin"] });
		},
	});
}
