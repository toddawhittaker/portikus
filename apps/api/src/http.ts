import type { ApiError } from "@portikus/contracts";
import type { FastifyReply } from "fastify";
import { type ZodType, z } from "zod";

export const UuidParam = z.object({ id: z.string().uuid() });
export const ProjectParam = z.object({ id: z.string().uuid(), pid: z.string().uuid() });

// Path parameters of the course routes; the routes and the catalog both use these.
export const CourseParam = z.object({ courseId: z.string().uuid() });
export const CourseMemberParam = CourseParam.extend({ userId: z.string().uuid() });
export const CourseSessionParam = CourseParam.extend({ sid: z.string().uuid() });
export const CourseSharedParam = CourseParam.extend({ projectId: z.string().uuid() });

/** A process id in a path: digits with no leading zero, at most ten of them. */
export const PID_PATTERN = /^[1-9]\d{0,9}$/;
/** The workspace id and process id of a process action. */
export const ProcessParam = UuidParam.extend({ pid: z.string().regex(PID_PATTERN) });

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

/** The 404 for a workspace that does not exist or that the caller may not see. */
export function sendWorkspaceNotFound(reply: FastifyReply): FastifyReply {
	return sendError(reply, 404, "WORKSPACE_NOT_FOUND", "Workspace not found");
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
	// Only our own custom messages are shown; Zod's built-in ones can quote the input.
	const fields = [
		...new Set(
			parsed.error.issues.map((i) => {
				const path = i.path.join(".");
				return i.code === "custom" ? `${path} (${i.message})` : path;
			}),
		),
	];
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
