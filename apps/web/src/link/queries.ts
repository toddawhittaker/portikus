import { PendingLink } from "@portikus/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { ApiError, request } from "../api/request.js";

/** The two accounts waiting to be linked, or null when none is (a 404). */
export function usePendingLink(enabled: boolean) {
	return useQuery({
		queryKey: ["me", "links", "pending"],
		enabled,
		retry: false,
		queryFn: async () => {
			try {
				return await request(PendingLink, "/me/links/pending");
			} catch (error) {
				if (error instanceof ApiError && error.status === 404) return null;
				throw error;
			}
		},
	});
}

/** docs/EPIC-13-1.md, "The flow" step 5. */
export function useConfirmLink() {
	return useMutation({
		mutationFn: () => request(z.unknown(), "/me/links/confirm", { method: "POST" }),
	});
}
