import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ApiError } from "../api/request.js";
import { json, operation, project, stubFetch, WORKSPACE } from "../test-utils.js";
import {
	followOperation,
	isOperationHandled,
	isOperationStartedHere,
	LOST_OPERATION_MESSAGE,
	markOperationHandled,
	postOperation,
	RETRY_FOR_MS,
	UNREACHABLE_MESSAGE,
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

test("a failed check is tried again, and the real outcome is shown and marked", async () => {
	const made = project({ name: "lab" });
	let reads = 0;
	stubFetch((url) => {
		if (url !== READ) return json(202, STARTED);
		reads += 1;
		// A proxy's 502 and a dropped connection say nothing about the operation.
		if (reads === 1)
			return json(502, { error: { code: "INTERNAL", message: "Bad gateway" } });
		if (reads === 2) throw new TypeError("Failed to fetch");
		return json(200, { operation: { ...STARTED, state: "succeeded", project: made } });
	});
	const answer = await postOperation(WORKSPACE.id, URL, {});
	expect(answer).toEqual(made);
	expect(reads).toBe(3);
	expect(isOperationStartedHere(STARTED.id)).toBe(true);
	expect(isOperationHandled(STARTED.id)).toBe(true);
}, 15_000);

test("checks that keep failing give up without marking the operation shown", async () => {
	vi.useFakeTimers();
	try {
		stubFetch((url) => {
			if (url === READ) throw new TypeError("Failed to fetch");
			return json(202, STARTED);
		});
		const failure = postOperation(WORKSPACE.id, URL, {}).catch((error) => error);
		await vi.advanceTimersByTimeAsync(RETRY_FOR_MS + 20_000);
		const error = await failure;
		expect(error).toBeInstanceOf(ApiError);
		expect(error.message).toBe(UNREACHABLE_MESSAGE);
		// A reload still shows how it went.
		expect(isOperationHandled(STARTED.id)).toBe(false);
	} finally {
		vi.useRealTimers();
	}
});

test("an aborted follow stops checking and is not marked shown", async () => {
	const fetchMock = server(json(202, STARTED), STARTED, STARTED, STARTED);
	const controller = new AbortController();
	const followed = followOperation(WORKSPACE.id, STARTED, controller.signal).catch(
		(error) => error,
	);
	controller.abort(new DOMException("closed", "AbortError"));
	expect(await followed).toBeInstanceOf(DOMException);
	await new Promise((resolve) => setTimeout(resolve, 1200));
	expect(fetchMock).not.toHaveBeenCalled();
	expect(isOperationHandled(STARTED.id)).toBe(false);
});
