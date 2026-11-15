import { OPERATIONS, type Risk } from "../catalog/index.js";
import type { JsonSchema } from "../catalog/openapi.js";
import { splitKey } from "../route-policy.js";
import { type McpCaller, mayRun } from "./caller.js";
import { operationInputJson } from "./schema.js";

/** At most this many matches come back, so an answer stays small. */
const FIND_LIMIT = 10;

export interface FoundOperation {
	name: string;
	description: string;
	risk: Risk;
	input: JsonSchema;
}

function wordsOf(text: string): string[] {
	return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/**
 * The operations this key may run that best match the query's words, by
 * name and description. A query word matches a word it begins.
 */
export function findOperations(
	query: string,
	caller: Pick<McpCaller, "role" | "scope">,
): FoundOperation[] {
	const wanted = [...new Set(wordsOf(query))];
	const scored: { score: number; found: FoundOperation }[] = [];
	for (const [key, operation] of Object.entries(OPERATIONS)) {
		if (!mayRun(operation, caller)) continue;
		const words = wordsOf(`${operation.name} ${operation.description}`);
		const score = wanted.filter((word) =>
			words.some((one) => one.startsWith(word)),
		).length;
		if (score === 0) continue;
		scored.push({
			score,
			found: {
				name: operation.name,
				description: operation.description,
				risk: operation.risk,
				input: operationInputJson(operation, splitKey(key).url),
			},
		});
	}
	return scored
		.sort((a, b) => b.score - a.score || a.found.name.localeCompare(b.found.name))
		.slice(0, FIND_LIMIT)
		.map((one) => one.found);
}
