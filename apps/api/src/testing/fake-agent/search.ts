import {
	PATTERN_INVALID_MESSAGE,
	type SearchMatch,
	SearchQuery,
} from "@portikus/contracts";
import type { FastifyInstance } from "fastify";
import { FakeFileError } from "./fs-model.js";
import type { FakeAgentState } from "./state.js";

/** Project search, like the agent's search-routes.ts (SPEC.md §11.5). */
export function registerSearchRoutes(app: FastifyInstance, s: FakeAgentState): void {
	const {
		flags,
		searchAnswers,
		searchTruncated,
		lastSearches,
		projectNotFound,
		answerKey,
		keyOf,
		dirs,
		fileError,
	} = s;
	app.get("/projects/:slug/search", async (request, reply) => {
		const slug = (request.params as { slug: string }).slug;
		if (!dirs(request).has(slug)) return projectNotFound(reply);
		const query = SearchQuery.safeParse(request.query ?? {});
		if (!query.success) {
			return fileError(reply, new FakeFileError("BAD_REQUEST", "invalid search query"));
		}
		// A query the test marks as busy stands in for one past the running cap.
		if (query.data.q.includes("busy")) {
			return reply
				.status(409)
				.send({ error: { code: "BUSY", message: "too many searches are running" } });
		}
		// A query the test marks as slow stands in for a search still running
		// when the browser gives up, so cancellation can be observed.
		if (query.data.q.includes("slow")) {
			await new Promise<void>((resolve) => {
				const onClose = () => {
					flags.searchAborted += 1;
					clearTimeout(timer);
					resolve();
				};
				const timer = setTimeout(() => {
					// The caller waited it out, so this search was not cancelled.
					request.raw.off("close", onClose);
					resolve();
				}, 5000);
				request.raw.on("close", onClose);
			});
			if (request.raw.destroyed) {
				// Nobody is listening any more, so send nothing at all.
				reply.hijack();
				return;
			}
		}
		const key = answerKey(keyOf(request), slug);
		lastSearches.set(key, query.data);
		// JavaScript's parser stands in for ripgrep's refusing a bad pattern.
		if (query.data.regex && !compiles(query.data.q)) {
			return reply.status(400).send({
				error: { code: "PATTERN_INVALID", message: PATTERN_INVALID_MESSAGE },
			});
		}
		const matches = searchAnswers.get(key) ?? [];
		return { matches, truncated: searchTruncated.get(key) ?? false };
	});

	app.post("/__test/search", async (request, reply) => {
		const body = request.body as {
			key?: string;
			slug: string;
			matches: SearchMatch[];
			truncated?: boolean;
		};
		const key = answerKey(body.key ?? "", body.slug);
		searchAnswers.set(key, body.matches);
		searchTruncated.set(key, body.truncated ?? false);
		return reply.status(204).send();
	});

	// What the last search of one project actually asked for.
	app.get("/__test/search/last", async (request) => {
		const query = request.query as { key?: string; slug: string };
		return lastSearches.get(answerKey(query.key ?? "", query.slug)) ?? null;
	});
}

function compiles(pattern: string): boolean {
	try {
		new RegExp(pattern);
		return true;
	} catch {
		return false;
	}
}
