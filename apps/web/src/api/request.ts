import { ApiError as ApiErrorBody } from "@portikus/contracts";
import type { ZodType } from "zod";

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

	if (response.status === 401) {
		throw new SessionEndedError();
	}

	if (!response.ok) {
		const body = await response.json().catch(() => null);
		const parsed = ApiErrorBody.safeParse(body);
		throw new ApiError(
			response.status,
			parsed.success ? parsed.data.message : "Something went wrong. Please try again.",
			parsed.success ? parsed.data.code : undefined,
		);
	}

	if (response.status === 204) {
		return undefined as T;
	}

	return schema.parse(await response.json());
}
