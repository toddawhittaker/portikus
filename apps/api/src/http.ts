import type { ApiError } from "@portikus/contracts";
import type { FastifyReply } from "fastify";
import { type ZodType, z } from "zod";

export const UuidParam = z.object({ id: z.string().uuid() });
export const ProjectParam = z.object({ id: z.string().uuid(), pid: z.string().uuid() });

/** Send the standard `{ code, message }` error body. */
export function sendError(
	reply: FastifyReply,
	statusCode: number,
	code: ApiError["code"],
	message: string,
): FastifyReply {
	const body: ApiError = { code, message };
	return reply.status(statusCode).send(body);
}

/** sendError for responses that must never be cached. */
export function sendNoStoreError(
	reply: FastifyReply,
	statusCode: number,
	code: ApiError["code"],
	message: string,
): FastifyReply {
	return sendError(
		reply.header("cache-control", "no-store"),
		statusCode,
		code,
		message,
	);
}

/**
 * Parse `value` through `schema`, or send a 400 VALIDATION_FAILED and return
 * null. The message defaults to the validation error's own text.
 */
export function parseOr400<T>(
	schema: ZodType<T>,
	value: unknown,
	reply: FastifyReply,
	message?: string,
): T | null {
	const parsed = schema.safeParse(value);
	if (parsed.success) return parsed.data;
	sendError(reply, 400, "VALIDATION_FAILED", message ?? parsed.error.message);
	return null;
}

/**
 * parseOr400 for a body that may hold secrets: Zod's issues can quote the
 * input, so the message names only the fields.
 */
export function parseFieldsOr400<T>(
	schema: ZodType<T>,
	value: unknown,
	reply: FastifyReply,
): T | null {
	const parsed = schema.safeParse(value);
	if (parsed.success) return parsed.data;
	const fields = [...new Set(parsed.error.issues.map((i) => i.path.join(".")))];
	sendError(
		reply,
		400,
		"VALIDATION_FAILED",
		`Check these fields: ${fields.join(", ") || "settings"}.`,
	);
	return null;
}

/** Escape text for an HTML body or a quoted attribute. */
export function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}
