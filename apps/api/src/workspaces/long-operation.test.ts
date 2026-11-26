import { randomUUID } from "node:crypto";
import type { Project } from "@portikus/contracts";
import type { FastifyBaseLogger } from "fastify";
import { afterEach, expect, test, vi } from "vitest";
import { sendError } from "../http.js";
import {
	currentOperation,
	FINISHED_OPERATION_KEEP_MS,
	holdLongOperation,
	releaseLongOperation,
	runningOperation,
	startOperation,
} from "./long-operation.js";

const log = { error: vi.fn() } as unknown as FastifyBaseLogger;

const PROJECT: Project = {
	id: randomUUID(),
	workspaceId: randomUUID(),
	slug: "lab",
	name: "lab",
	path: "/home/student/projects/lab",
	state: "active",
	source: "clone",
	isGitRepo: true,
	missing: false,
	createdAt: new Date().toISOString(),
	archivedAt: null,
};

afterEach(() => {
	vi.useRealTimers();
});

/** A promise the test resolves or rejects when it chooses. */
function gate<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

function begin(workspaceId: string, work: Parameters<typeof startOperation>[1]) {
	expect(holdLongOperation(workspaceId)).toBe(true);
	return startOperation(
		{
			workspaceId,
			key: "create:lab",
			kind: "create",
			projectId: null,
			pointId: null,
			log,
		},
		work,
	);
}

async function settled(workspaceId: string) {
	await vi.waitFor(() =>
		expect(currentOperation(workspaceId)?.state).not.toBe("running"),
	);
	return currentOperation(workspaceId);
}

test("a started operation is running, holds the slot, and is found by its key", async () => {
	const workspaceId = randomUUID();
	const done = gate<Project | null>();
	const started = begin(workspaceId, () => done.promise);

	expect(started.state).toBe("running");
	expect(started.finishedAt).toBeNull();
	expect(currentOperation(workspaceId)).toEqual(started);
	expect(runningOperation(workspaceId, "create:lab")).toEqual(started);
	// A different request is not the same one, and the slot is taken.
	expect(runningOperation(workspaceId, "create:other")).toBeNull();
	expect(holdLongOperation(workspaceId)).toBe(false);

	done.resolve(PROJECT);
	const finished = await settled(workspaceId);
	expect(finished).toMatchObject({
		id: started.id,
		state: "succeeded",
		project: PROJECT,
	});
	expect(finished?.finishedAt).not.toBeNull();
	// A finished operation is not joined, and the slot is free again.
	expect(runningOperation(workspaceId, "create:lab")).toBeNull();
	expect(holdLongOperation(workspaceId)).toBe(true);
	releaseLongOperation(workspaceId);
});

test("a refusal sent on the reply becomes the operation's error, with its status", async () => {
	const workspaceId = randomUUID();
	begin(workspaceId, async (reply) => {
		sendError(
			reply,
			409,
			"PROJECT_EXISTS",
			"A folder named lab is already in ~/projects.",
		);
		return null;
	});
	expect(await settled(workspaceId)).toMatchObject({
		state: "failed",
		project: null,
		error: {
			status: 409,
			code: "PROJECT_EXISTS",
			message: "A folder named lab is already in ~/projects.",
		},
	});
	expect(holdLongOperation(workspaceId)).toBe(true);
	releaseLongOperation(workspaceId);
});

test("a 204 with no project is a success, as a restore is", async () => {
	const workspaceId = randomUUID();
	begin(workspaceId, async (reply) => {
		reply.status(204).send();
		return null;
	});
	expect(await settled(workspaceId)).toMatchObject({
		state: "succeeded",
		project: null,
		error: null,
	});
});

test("work that throws fails with the plain sentence and is logged", async () => {
	const workspaceId = randomUUID();
	begin(workspaceId, async () => {
		throw new Error("database gone");
	});
	expect(await settled(workspaceId)).toMatchObject({
		state: "failed",
		error: {
			status: 500,
			code: "INTERNAL",
			message: "Something went wrong. Please try again.",
		},
	});
	expect(log.error).toHaveBeenCalled();
	expect(holdLongOperation(workspaceId)).toBe(true);
	releaseLongOperation(workspaceId);
});

test("a finished operation is kept for a reload, then forgotten", async () => {
	vi.useFakeTimers();
	const workspaceId = randomUUID();
	begin(workspaceId, async () => PROJECT);
	await vi.advanceTimersByTimeAsync(0);
	expect(currentOperation(workspaceId)?.state).toBe("succeeded");

	await vi.advanceTimersByTimeAsync(FINISHED_OPERATION_KEEP_MS - 1000);
	expect(currentOperation(workspaceId)?.state).toBe("succeeded");
	await vi.advanceTimersByTimeAsync(1000);
	expect(currentOperation(workspaceId)).toBeNull();
});

test("a newer operation is not forgotten when an older one's time runs out", async () => {
	vi.useFakeTimers();
	const workspaceId = randomUUID();
	begin(workspaceId, async () => PROJECT);
	await vi.advanceTimersByTimeAsync(FINISHED_OPERATION_KEEP_MS - 1000);
	const newer = begin(workspaceId, async () => PROJECT);
	await vi.advanceTimersByTimeAsync(1000);
	expect(currentOperation(workspaceId)?.id).toBe(newer.id);
});
