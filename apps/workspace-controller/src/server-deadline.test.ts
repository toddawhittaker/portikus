import { EventEmitter } from "node:events";
import {
	CONTROLLER_BUDGET_HEADER,
	type CreateInstanceResponse,
	INSTANCE_CREATE_BUDGET_MS,
} from "@portikus/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { FakeWorkspaceProvider } from "./fake-provider.js";
import { buildServer, callerSignal } from "./server.js";

// The caller's deadline reaches the provider (ADR 0034, SPEC.md section 25.3).
// These run on a real listener so a client hang-up is a real closed socket.

const TOKEN = "test-token-value";
const BODY = { name: "ws-abc", homeGiB: 25, dockerGiB: 20, recoveryGiB: 3 };
const RESULT: CreateInstanceResponse = {
	created: true,
	imageFingerprint: "abc",
	quota: { homeGiB: 25, dockerGiB: 20 },
};

interface Call {
	signal: AbortSignal;
	resolve: (r: CreateInstanceResponse) => void;
	reject: (e: unknown) => void;
}

/** A provider whose creates wait until the test settles them. */
class GatedProvider extends FakeWorkspaceProvider {
	calls: Call[] = [];
	override create(
		_name: string,
		_sizes: { homeGiB: number; dockerGiB: number; recoveryGiB: number },
		signal?: AbortSignal,
	): Promise<CreateInstanceResponse> {
		return new Promise((resolve, reject) => {
			this.calls.push({ signal: signal as AbortSignal, resolve, reject });
		});
	}
}

let provider: GatedProvider;
let app: FastifyInstance;
let base: string;

beforeEach(async () => {
	provider = new GatedProvider();
	app = buildServer({ provider, token: TOKEN });
	base = await app.listen({ port: 0, host: "127.0.0.1" });
});

afterEach(async () => {
	for (const c of provider.calls) c.reject(new Error("test over"));
	await app.close();
});

function create(
	opts: { budgetMs?: number; signal?: AbortSignal } = {},
): Promise<Response> {
	return fetch(`${base}/instances`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${TOKEN}`,
			"content-type": "application/json",
			...(opts.budgetMs ? { [CONTROLLER_BUDGET_HEADER]: String(opts.budgetMs) } : {}),
		},
		body: JSON.stringify(BODY),
		signal: opts.signal,
	});
}

/** Resolves once the provider has been called `n` times. */
async function calls(n: number): Promise<Call[]> {
	await vi.waitFor(() => expect(provider.calls.length).toBe(n));
	return provider.calls;
}

function aborted(signal: AbortSignal): Promise<void> {
	return new Promise((r) =>
		signal.aborted ? r() : signal.addEventListener("abort", () => r()),
	);
}

test("the budget header aborts the provider's create and answers TIMEOUT", async () => {
	const res = create({ budgetMs: 100 });
	const [call] = await calls(1);
	const answer = await res;
	expect(answer.status).toBe(504);
	expect(((await answer.json()) as { code: string }).code).toBe("TIMEOUT");
	expect(call?.signal.aborted).toBe(true);
});

test("a caller hanging up aborts the provider's create", async () => {
	const hangUp = new AbortController();
	const res = create({ signal: hangUp.signal }).catch(() => null);
	const [call] = await calls(1);
	expect(call?.signal.aborted).toBe(false);
	hangUp.abort();
	await res;
	await aborted(call?.signal as AbortSignal);
});

test("two concurrent creates make one provider call and both get its result", async () => {
	const a = create();
	const b = create();
	const [call] = await calls(1);
	// Let the second request reach the route before the work settles.
	await new Promise((r) => setTimeout(r, 50));
	call?.resolve(RESULT);
	for (const res of [await a, await b]) {
		expect(res.status).toBe(201);
		expect(await res.json()).toEqual(RESULT);
	}
	expect(provider.calls).toHaveLength(1);
});

test("one caller leaving keeps the shared create running for the other", async () => {
	const leaver = new AbortController();
	const gone = create({ signal: leaver.signal }).catch(() => null);
	const [call] = await calls(1);
	const stays = create();
	await new Promise((r) => setTimeout(r, 50));
	leaver.abort();
	await gone;
	await new Promise((r) => setTimeout(r, 50));
	expect(call?.signal.aborted).toBe(false);
	call?.resolve(RESULT);
	const res = await stays;
	expect(res.status).toBe(201);
	expect(provider.calls).toHaveLength(1);
});

test("the shared create is aborted once every caller has left", async () => {
	const one = new AbortController();
	const two = new AbortController();
	const a = create({ signal: one.signal }).catch(() => null);
	const [call] = await calls(1);
	const b = create({ signal: two.signal }).catch(() => null);
	await new Promise((r) => setTimeout(r, 50));
	one.abort();
	await a;
	await new Promise((r) => setTimeout(r, 50));
	expect(call?.signal.aborted).toBe(false);
	two.abort();
	await b;
	await aborted(call?.signal as AbortSignal);
});

test("a caller arriving after an abort waits for the wind-down, then runs afresh", async () => {
	const first = create({ budgetMs: 50 });
	const [old] = await calls(1);
	expect((await first).status).toBe(504);
	await aborted(old?.signal as AbortSignal);

	const next = create();
	await new Promise((r) => setTimeout(r, 50));
	// Still winding down: the new caller has not joined the aborted run.
	expect(provider.calls).toHaveLength(1);
	old?.reject(new Error("aborted"));
	const [, fresh] = await calls(2);
	expect(fresh?.signal.aborted).toBe(false);
	fresh?.resolve(RESULT);
	expect((await next).status).toBe(201);
});

test("the processes read gets the caller's signal", async () => {
	let seen: AbortSignal | undefined;
	provider.processes = async (_name: string, signal?: AbortSignal) => {
		seen = signal;
		return [];
	};
	const res = await fetch(`${base}/instances/ws-abc/processes`, {
		headers: { authorization: `Bearer ${TOKEN}`, [CONTROLLER_BUDGET_HEADER]: "5000" },
	});
	expect(res.status).toBe(200);
	expect(seen).toBeInstanceOf(AbortSignal);
});

function fakeExchange(headers: Record<string, string>) {
	const raw = Object.assign(new EventEmitter(), { writableEnded: false });
	return {
		request: { headers } as unknown as FastifyRequest,
		reply: { raw } as unknown as FastifyReply,
		raw,
	};
}

test("without a budget header the signal falls back to the given budget", () => {
	vi.useFakeTimers();
	try {
		const { request, reply } = fakeExchange({});
		const signal = callerSignal(request, reply, INSTANCE_CREATE_BUDGET_MS);
		vi.advanceTimersByTime(INSTANCE_CREATE_BUDGET_MS - 1);
		expect(signal.aborted).toBe(false);
		vi.advanceTimersByTime(1);
		expect(signal.aborted).toBe(true);
	} finally {
		vi.useRealTimers();
	}
});

test("a reply that finished normally does not abort the signal", () => {
	const { request, reply, raw } = fakeExchange({ [CONTROLLER_BUDGET_HEADER]: "1000" });
	const signal = callerSignal(request, reply, 30_000);
	raw.writableEnded = true;
	raw.emit("close");
	expect(signal.aborted).toBe(false);
});

test("a budget header above the fallback is clamped to it", () => {
	vi.useFakeTimers();
	try {
		const { request, reply } = fakeExchange({
			[CONTROLLER_BUDGET_HEADER]: String(Number.MAX_SAFE_INTEGER),
		});
		const signal = callerSignal(request, reply, 30_000);
		vi.advanceTimersByTime(29_999);
		expect(signal.aborted).toBe(false);
		vi.advanceTimersByTime(1);
		expect(signal.aborted).toBe(true);
	} finally {
		vi.useRealTimers();
	}
});

test("a malformed budget header falls back", () => {
	vi.useFakeTimers();
	try {
		const { request, reply } = fakeExchange({ [CONTROLLER_BUDGET_HEADER]: "soon" });
		const signal = callerSignal(request, reply, 30_000);
		vi.advanceTimersByTime(29_999);
		expect(signal.aborted).toBe(false);
		vi.advanceTimersByTime(1);
		expect(signal.aborted).toBe(true);
	} finally {
		vi.useRealTimers();
	}
});
