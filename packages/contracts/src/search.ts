import { z } from "zod";

/** The most matches one search returns before it reports truncation. */
export const MAX_SEARCH_MATCHES = 500;

/** How long a single search may run before the agent stops it. */
export const SEARCH_TIMEOUT_MS = 10_000;

/**
 * One matching line, with at most one line of context on each side
 * (SPEC.md §11.5). The path is relative to the project root.
 */
export const SearchMatch = z.object({
	path: z.string(),
	line: z.number().int().positive(),
	column: z.number().int().positive(),
	text: z.string(),
	before: z.array(z.string()),
	after: z.array(z.string()),
});
export type SearchMatch = z.infer<typeof SearchMatch>;

/** Response body for `GET /projects/:slug/search` (SPEC.md §11.5). */
export const SearchResponse = z.object({
	matches: z.array(SearchMatch),
	truncated: z.boolean(),
});
export type SearchResponse = z.infer<typeof SearchResponse>;

/** Query string for `GET /projects/:slug/search` (SPEC.md §11.5). */
export const SearchQuery = z.object({
	q: z.string().min(1).max(512),
	hidden: z.coerce.boolean().default(false),
});
export type SearchQuery = z.infer<typeof SearchQuery>;
