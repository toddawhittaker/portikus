import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

/**
 * How the request being served arrived (SPEC.md section 24.11). The API sets
 * it once per request; `recordAudit` reads it, so no call site passes it.
 * Code outside a request, such as the worker, leaves both fields empty.
 */
export interface AuditArrival {
	via: "session" | "api_key" | "assistant";
	/** The key that signed the request in, when `via` is `api_key`. */
	apiKeyId: string | null;
}

export const auditArrival = new AsyncLocalStorage<AuditArrival>();

/**
 * Marks a request the in-process runner sends for the built-in assistant.
 * Fastify's inject does not carry an AsyncLocalStorage store into the
 * request, so the mark is a header whose name and value are drawn at random
 * when the process starts: nothing outside it can know them. The auth plugin
 * checks the mark and deletes it before any route sees it, and answers the
 * signed-in person's id under the same name so the runner can audit the call.
 */
export const ASSISTANT_MARK = {
	header: `x-portikus-assistant-${randomBytes(8).toString("hex")}`,
	value: randomBytes(32).toString("hex"),
} as const;
