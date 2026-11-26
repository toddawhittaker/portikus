import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ApiError } from "../api/request.js";
import { json, operation, project, stubFetch, WORKSPACE } from "../test-utils.js";
import {
	isOperationHandled,
	LOST_OPERATION_MESSAGE,
	markOperationHandled,
	postOperation,
} from "./operations.js";

const URL = `/workspaces/${WORKSPACE.id}/projects`;
const READ = `/workspaces/${WORKSPACE.id}/project-operation`;
const STARTED = operation();

beforeEach(() => {
	sessionStorage.clear();
});
afterEach(() => {
	vi.unstubAllGlobals();
});

/** A server whose operation reads answer with `reads` in turn. */
function server(start: Response, ...reads: unknown[]) {
	return stubFetch((url) => {
		if (url === READ) return json(200, { operation: reads.shift() ?? null });
		return start;
	});
}

test("a 202 is followed until it succeeds, and answers with the new project", async () => {
	const made = project({ slug: "lab", name: "lab" });
	const fetchMock = server(json(202, STARTED), STARTED, {
		...STARTED,
		state: "succeeded",
		project: made,
	});
	const answer = await postOperation(WORKSPACE.id, URL, { name: "lab" });
	expect(answer).toEqual(made);
	expect(fetchMock.mock.calls.filter(([url]) => String(url) === READ)).toHaveLength(2);
	// This page showed the outcome, so a reload does not show it again.
	expect(isOperationHandled(STARTED.id)).toBe(true);
});

test("a failed operation throws the error the request used to, with its code", async () => {
	server(json(202, STARTED), {
		...STARTED,
		state: "failed",
		error: { status: 507, code: "STORAGE_FULL", message: "Recovery storage is full." },
	});
	const failure = await postOperation(WORKSPACE.id, URL, {}).catch((error) => error);
	expect(failure).toBeInstanceOf(ApiError);
	expect(failure).toMatchObject({
		status: 507,
		code: "STORAGE_FULL",
		message: "Recovery storage is full.",
	});
});

test("an operation the server no longer knows says so", async () => {
	server(json(202, STARTED), null);
	const failure = await postOperation(WORKSPACE.id, URL, {}).catch((error) => error);
	expect(failure).toBeInstanceOf(ApiError);
	expect(failure.message).toBe(LOST_OPERATION_MESSAGE);
});

test("a refusal and an immediate answer are read as before", async () => {
	server(
		json(409, {
			code: "PROJECT_EXISTS",
			message: "A project called lab already exists.",
		}),
	);
	await expect(postOperation(WORKSPACE.id, URL, {})).rejects.toMatchObject({
		status: 409,
		message: "A project called lab already exists.",
	});
	vi.unstubAllGlobals();
	const made = project();
	server(json(201, made));
	expect(await postOperation(WORKSPACE.id, URL, {})).toEqual(made);
});

test("the handled mark keeps only the latest operation", () => {
	markOperationHandled("a");
	markOperationHandled("b");
	expect(isOperationHandled("a")).toBe(false);
	expect(isOperationHandled("b")).toBe(true);
});
