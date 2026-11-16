import type { ApiKeyScope } from "@portikus/contracts";
import type { Risk } from "../catalog/index.js";

/** Scope is one ordered level: destructive includes write includes read (SPEC.md section 24.13). */
const SCOPE_LEVEL: Record<ApiKeyScope, number> = { read: 0, write: 1, destructive: 2 };
const RISK_LEVEL: Record<Risk, number> = { read: 0, change: 1, destructive: 2 };

/** Whether a key of this scope may run an operation of this risk. */
export function riskWithinScope(risk: Risk, scope: ApiKeyScope): boolean {
	return RISK_LEVEL[risk] <= SCOPE_LEVEL[scope];
}

/** What a key below an operation's risk is told (the `SCOPE_REQUIRED` answer). */
export function scopeRequiredMessage(risk: Risk): string {
	return `This action needs a key with ${risk === "destructive" ? "destructive" : "write"} scope.`;
}
