import { ApiError as ApiErrorBody } from "@portikus/contracts";
import type { ZodType } from "zod";

/** The fallback sentence when an error carries no message of its own (SPEC.md §28). */
export const SOMETHING_WENT_WRONG = "Something went wrong. Please try again.";

/** Thrown when the API says the session is gone (401), so the app must log in again. */
export class SessionEndedError extends Error {
	constructor() {
		super("Your session has ended. Please sign in again.");
		this.name = "SessionEndedError";
	}
}

/** Thrown for any other error response (SPEC.md §27 error body). */
export class ApiError extends Error {
	readonly status: number;
	readonly code: string | undefined;

	constructor(status: number, message: string, code?: string) {
		super(message);
		this.name = "ApiError";
		this.status = status;
		this.code = code;
	}
}

/** Turn an error response into the error the caller should see (SPEC.md §27). */
export async function toApiError(response: Response): Promise<Error> {
	if (response.status === 401) return new SessionEndedError();
	const body = await response.json().catch(() => null);
	const parsed = ApiErrorBody.safeParse(body);
	return new ApiError(
		response.status,
		parsed.success ? parsed.data.message : SOMETHING_WENT_WRONG,
		parsed.success ? parsed.data.code : undefined,
	);
}

/**
 * Fetch `input` and parse the response through `schema`. A 204 resolves to
 * undefined, which is why callers of a no-content route pass a schema that
 * accepts it.
 */
export async function request<T>(
	schema: ZodType<T>,
	input: string,
	init?: RequestInit,
): Promise<T> {
	const response = await fetch(input, { credentials: "same-origin", ...init });

	if (!response.ok) {
		throw await toApiError(response);
	}

	if (response.status === 204) {
		return undefined as T;
	}

	return schema.parse(await response.json());
}

/** Send `body` as JSON and parse the response through `schema`, as `request` does. */
export function postJson<T>(
	schema: ZodType<T>,
	input: string,
	body: unknown,
	method: "POST" | "PUT" | "PATCH" | "DELETE" = "POST",
): Promise<T> {
	return request(schema, input, {
		method,
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

/** What to show for a failed call: the API's own sentence, or the fallback. */
export function errorText(error: unknown): string {
	if (error instanceof ApiError) return error.message;
	return SOMETHING_WENT_WRONG;
}
