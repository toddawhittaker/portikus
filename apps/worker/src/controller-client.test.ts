import * as http from "node:http";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { ControllerClientError, HttpControllerClient } from "./controller-client.js";

let server: http.Server;
let baseUrl: string;
let seen: Array<{ method: string; url: string; auth: string; body: string }>;
let answer: { status: number; body: unknown };

beforeAll(async () => {
	seen = [];
	server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			seen.push({
				method: req.method ?? "",
				url: req.url ?? "",
				auth: req.headers.authorization ?? "",
				body: Buffer.concat(chunks).toString(),
			});
			res.writeHead(answer.status, { "Content-Type": "application/json" });
			res.end(answer.status === 204 ? undefined : JSON.stringify(answer.body));
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
	await new Promise<void>((r) => server.close(() => r()));
});

const USAGE = {
	name: "ws-a",
	cpuUsageNs: 5,
	bootMarker: 77,
	cpuLimit: 4,
	memoryBytes: 10,
	memoryLimitBytes: 20,
	cpuAllowance: null,
};

test("usage reads GET /instances/usage and returns the instances", async () => {
	seen = [];
	answer = { status: 200, body: { instances: [USAGE] } };
	const client = new HttpControllerClient(baseUrl, "tok");

	expect(await client.usage()).toEqual([USAGE]);
	expect(seen).toEqual([
		{ method: "GET", url: "/instances/usage", auth: "Bearer tok", body: "" },
	]);
});

test("usage refuses a reply that breaks the contract", async () => {
	answer = { status: 200, body: { instances: [{ ...USAGE, cpuLimit: 0 }] } };
	await expect(new HttpControllerClient(baseUrl, "tok").usage()).rejects.toThrow();
});

test("setCpuAllowance sends the allowance, or null to remove it", async () => {
	seen = [];
	answer = { status: 204, body: null };
	const client = new HttpControllerClient(baseUrl, "tok");

	await client.setCpuAllowance("ws-a", "100ms/100ms");
	await client.setCpuAllowance("ws-a", null);

	expect(seen.map((r) => [r.method, r.url, JSON.parse(r.body)])).toEqual([
		["PUT", "/instances/ws-a/cpu-allowance", { allowance: "100ms/100ms" }],
		["PUT", "/instances/ws-a/cpu-allowance", { allowance: null }],
	]);
});

test("a controller error keeps its code", async () => {
	answer = { status: 404, body: { code: "NOT_FOUND", message: "gone" } };
	await expect(
		new HttpControllerClient(baseUrl, "tok").setCpuAllowance("ws-a", null),
	).rejects.toMatchObject({ code: "NOT_FOUND" });
});

/** A fetch that never answers, and fails only when its signal aborts. */
function hangingFetch(): typeof fetch {
	return ((_url: string, init?: RequestInit) =>
		new Promise((_resolve, reject) => {
			init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
		})) as typeof fetch;
}

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

test("a stop over its budget is aborted with TIMEOUT", async () => {
	vi.useFakeTimers();
	vi.stubGlobal("fetch", hangingFetch());
	const client = new HttpControllerClient("http://controller", "tok");

	const stop = client.stop("ws-a", 30);
	const caught = stop.catch((e: unknown) => e);
	// Budget is 2 x 30 + 15 = 75 seconds.
	await vi.advanceTimersByTimeAsync(74_000);
	expect(await Promise.race([caught, Promise.resolve("pending")])).toBe("pending");
	await vi.advanceTimersByTimeAsync(1_000);
	const err = await caught;
	expect(err).toBeInstanceOf(ControllerClientError);
	expect((err as ControllerClientError).code).toBe("TIMEOUT");
});

test("each call has its budget", async () => {
	vi.useFakeTimers();
	vi.stubGlobal("fetch", hangingFetch());
	const client = new HttpControllerClient("http://controller", "tok");
	const req = {
		timeoutSeconds: 60,
		agentToken: "t",
		hostname: "h",
		previewHostSuffix: "p",
		timezone: "UTC",
		dockerGiB: 20,
		recoveryGiB: 3,
	};
	const cases: Array<[string, () => Promise<unknown>, number]> = [
		["list", () => client.list(), 30_000],
		["setLogLevel", () => client.setLogLevel("info"), 30_000],
		["start", () => client.start("ws-a", req), 90_000],
		[
			"create",
			() => client.create({ name: "ws-a", homeGiB: 1, dockerGiB: 1, recoveryGiB: 1 }),
			300_000,
		],
		[
			"rebuild",
			() => client.rebuild("ws-a", { resetDocker: false, dockerGiB: 1 }),
			900_000,
		],
		["resetDocker", () => client.resetDocker("ws-a", { dockerGiB: 1 }), 900_000],
		["hostSnapshot", () => client.hostSnapshot(), 30_000],
		["usage", () => client.usage(), 30_000],
		["setCpuAllowance", () => client.setCpuAllowance("ws-a", null), 30_000],
		[
			"growVolumes",
			() => client.growVolumes("ws-a", { homeGiB: 1, dockerGiB: 1 }),
			300_000,
		],
	];
	for (const [name, call, budgetMs] of cases) {
		const caught = call().catch((e: unknown) => e);
		await vi.advanceTimersByTimeAsync(budgetMs - 1);
		expect(await Promise.race([caught, Promise.resolve("pending")]), name).toBe(
			"pending",
		);
		await vi.advanceTimersByTimeAsync(1);
		expect(((await caught) as ControllerClientError).code, name).toBe("TIMEOUT");
	}
});

test("a caller's own abort reads as unreachable, not TIMEOUT", async () => {
	vi.stubGlobal("fetch", hangingFetch());
	const client = new HttpControllerClient("http://controller", "tok");
	const ac = new AbortController();
	const caught = client.usage(ac.signal).catch((e: unknown) => e);
	ac.abort();
	expect(((await caught) as ControllerClientError).code).toBe("INCUS_UNAVAILABLE");
});
