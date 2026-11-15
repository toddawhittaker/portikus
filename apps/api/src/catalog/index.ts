import * as courses from "./families/courses.js";
import * as people from "./families/people.js";
import * as site from "./families/site.js";
import * as workspaces from "./families/workspaces.js";
import { NOT_EXPOSED } from "./not-exposed.js";
import type { Operation, OperationRecords } from "./types.js";

export type { Audience, NotExposed, Operation, OperationInput, Risk } from "./types.js";

const FAMILIES = [people, workspaces, site, courses];

/** Merge every family's records, refusing a route or a name given twice. */
function mergeOperations(): OperationRecords {
	const merged: OperationRecords = {};
	const names = new Set<string>();
	for (const family of FAMILIES) {
		for (const [key, operation] of Object.entries(family.operations)) {
			if (key in merged) {
				throw new Error(`catalog: ${key} has two records`);
			}
			if (names.has(operation.name)) {
				throw new Error(`catalog: the name ${operation.name} is used twice`);
			}
			names.add(operation.name);
			merged[key] = operation;
		}
	}
	return merged;
}

/** Every exposed operation, keyed by `"METHOD url"` as in `ROUTE_POLICY`. */
export const OPERATIONS: OperationRecords = mergeOperations();

/** Exposed routes whose record has not been written yet. */
export const PENDING: readonly string[] = FAMILIES.flatMap((family) => family.pending);

export { NOT_EXPOSED };

/**
 * Catalog routes that `ROUTE_POLICY` does not list yet: the key-management,
 * MCP and OpenAPI routes, which are built after the catalog.
 */
export const NEW_ROUTES: ReadonlySet<string> = new Set([
	"GET /mcp",
	"POST /mcp",
	"GET /openapi.json",
	"GET /me/api-keys",
	"POST /me/api-keys",
	"POST /me/api-keys/:id/renew",
	"POST /me/api-keys/:id/revoke",
	"GET /admin/api-keys",
	"POST /admin/api-keys/expire",
	"POST /admin/api-keys/revoke",
]);

const BY_NAME = new Map(Object.entries(OPERATIONS).map(([key, op]) => [op.name, key]));

/** The exposed operation for a route key, or undefined. A HEAD route uses its GET. */
export function operationByKey(key: string): Operation | undefined {
	return OPERATIONS[key.startsWith("HEAD ") ? `GET ${key.slice(5)}` : key];
}

/** The route key and operation with this name, or undefined. */
export function operationByName(
	name: string,
): { key: string; operation: Operation } | undefined {
	const key = BY_NAME.get(name);
	const operation = key === undefined ? undefined : OPERATIONS[key];
	return key !== undefined && operation !== undefined ? { key, operation } : undefined;
}
