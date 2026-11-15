import { AsyncLocalStorage } from "node:async_hooks";

/**
 * How the request being served arrived (SPEC.md section 24.11). The API sets
 * it once per request; `recordAudit` reads it, so no call site passes it.
 * Code outside a request, such as the worker, leaves both fields empty.
 */
export interface AuditArrival {
	via: "session" | "api_key";
	/** The key that signed the request in, when `via` is `api_key`. */
	apiKeyId: string | null;
}

export const auditArrival = new AsyncLocalStorage<AuditArrival>();
