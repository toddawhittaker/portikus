import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { ApiError, SessionEndedError } from "./request.js";

/** Codes the server answers while a session gate holds the account (SPEC.md section 5.3). */
const GATE_CODES = new Set(["PASSWORD_CHANGE_REQUIRED", "ACCEPTABLE_USE_REQUIRED"]);

/**
 * One QueryClient for the app. Every query and mutation goes through
 * `request`, so a lost session (401) can be handled in one place: the caller
 * passes what to do, which is "go to /session-ended".
 */
export function createQueryClient(onSessionEnded: () => void): QueryClient {
	const handle = (error: unknown) => {
		if (error instanceof SessionEndedError) onSessionEnded();
		// A gate that closed mid-session (a new statement): refetch the session,
		// so the router sends the page to the gate (SPEC.md section 5.1).
		if (error instanceof ApiError && GATE_CODES.has(error.code ?? "")) {
			void client.invalidateQueries({ queryKey: ["me"], exact: true });
		}
	};
	const client = new QueryClient({
		queryCache: new QueryCache({ onError: handle }),
		mutationCache: new MutationCache({ onError: handle }),
		defaultOptions: {
			queries: {
				// A lost session is not worth retrying, and neither is a 404.
				retry: false,
				refetchOnWindowFocus: true,
				staleTime: 5_000,
			},
		},
	});
	return client;
}
