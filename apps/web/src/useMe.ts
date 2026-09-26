import { MeResponse } from "@portikus/contracts";
import { useQuery } from "@tanstack/react-query";
import { ApiError, request, SessionEndedError } from "./api/request.js";

export type Role = MeResponse["role"];
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
	const query = useQuery({
		queryKey: ["me"],
		// A 401 here is the normal signed-out answer, not a lost session, so it
		// is caught rather than left to the QueryClient's session handler.
		queryFn: async (): Promise<MeState> => {
			try {
				return { status: "authenticated", user: await request(MeResponse, "/auth/me") };
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
 * does. The same order as the server's (docs/EPIC-14-3.md ruling 32).
 */
export function gatePath(me: MeState): "/change-password" | "/acceptable-use" | null {
	if (me.status !== "authenticated") return null;
	if (me.user.mustChangePassword) return "/change-password";
	if (me.user.mustAcceptUse) return "/acceptable-use";
	return null;
}
