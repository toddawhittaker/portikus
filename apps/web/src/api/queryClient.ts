import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { SessionEndedError } from "./request.js";

/**
 * One QueryClient for the app. Every query and mutation goes through
 * `request`, so a lost session (401) can be handled in one place: the caller
 * passes what to do, which is "go to /session-ended".
 */
export function createQueryClient(onSessionEnded: () => void): QueryClient {
	const handle = (error: unknown) => {
		if (error instanceof SessionEndedError) onSessionEnded();
	};
	return new QueryClient({
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
}
