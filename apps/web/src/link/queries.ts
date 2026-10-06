import { PendingLink } from "@portikus/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { ApiError, request, sendJson } from "../api/request.js";

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

/** ADR 0026. A Dex local-password account sends its second-factor code (SPEC.md section 24.13). */
export function useConfirmLink() {
	return useMutation({
		mutationFn: (code: string | undefined) =>
			sendJson(z.unknown(), "/me/links/confirm", code === undefined ? {} : { code }),
	});
}
