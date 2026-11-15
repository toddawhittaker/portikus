import { MeResponse } from "@portikus/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, request, SessionEndedError } from "./api/request.js";
import { editorSettingsKey } from "./editor/settingsQueries.js";
import { paneZoomsFor } from "./layout/paneZoomKeeper.js";

export type MeUser = MeResponse;

export type MeState =
	| { status: "loading" }
	| { status: "anonymous" }
	| { status: "forbidden" }
	| { status: "authenticated"; user: MeUser };

/**
 * Reads the current session from `GET /auth/me`. A 401 means nobody is
 * signed in; a 403 means the account exists but has no access to Portikus
 * (SPEC.md §5.2), which the not-authorized page explains.
 */
export function useMe(): MeState {
	const client = useQueryClient();
	const query = useQuery({
		queryKey: ["me"],
		// A 401 here is the normal signed-out answer, not a lost session, so it
		// is caught rather than left to the QueryClient's session handler.
		queryFn: async (): Promise<MeState> => {
			try {
				const user = await request(MeResponse, "/auth/me");
				// A different user's settings may already be cached, and their queryFn
				// is what seeds the pane zooms, so make it run again.
				if (paneZoomsFor(user.id)) {
					void client.invalidateQueries({ queryKey: editorSettingsKey, exact: true });
				}
				return { status: "authenticated", user };
			} catch (error) {
				if (error instanceof SessionEndedError) return { status: "anonymous" };
				if (error instanceof ApiError && error.status === 403) {
					return { status: "forbidden" };
				}
				throw error;
			}
		},
	});

	if (query.data) return query.data;
	if (query.isError) return { status: "anonymous" };
	return { status: "loading" };
}

/**
 * The page of the first gate still holding this account, or null when none
 * does. The same order as the server's (SPEC.md sections 5.1 and 24.13).
 */
export function gatePath(
	me: MeState,
): "/second-factor" | "/change-password" | "/acceptable-use" | null {
	if (me.status !== "authenticated") return null;
	if (me.user.secondFactor === "verify") return "/second-factor";
	if (me.user.mustChangePassword) return "/change-password";
	if (me.user.secondFactor === "enrol") return "/second-factor";
	if (me.user.mustAcceptUse) return "/acceptable-use";
	return null;
}
