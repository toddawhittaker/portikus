import type { z } from "zod";

/** How much a call can change: a read changes nothing, a destructive call cannot be undone. */
export type Risk = "read" | "change" | "destructive";

/** Who may run an operation: `staff` is administrators and instructors both. */
export type Audience = "administrator" | "instructor" | "staff";

/** The request parts an operation takes, named as Zod schemas (STACK.md section 5). */
export interface OperationInput {
	params?: z.ZodType;
	query?: z.ZodType;
	body?: z.ZodType;
}

/** One operation a key may run (SPEC.md section 27), keyed elsewhere by `"METHOD url"`. */
export interface Operation {
	/** Stable, `^[a-z_]+\.[a-z_]+$`. */
	name: string;
	/** One sentence. */
	description: string;
	risk: Risk;
	audience: Audience;
	/** True when the operation is a named MCP tool rather than only reachable through `run_operation`. */
	tool: boolean;
	input: OperationInput;
	output?: z.ZodType;
}

/** One family's records, keyed by the route's `"METHOD url"` as in `ROUTE_POLICY`. */
export type OperationRecords = Record<string, Operation>;

/** A route a key can never reach, and why. */
export interface NotExposed {
	reason: string;
	/** Set on routes no key may ever run, whatever its scope. */
	never?: true;
}
