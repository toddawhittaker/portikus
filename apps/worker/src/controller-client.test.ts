import * as http from "node:http";
import { afterAll, beforeAll, expect, test } from "vitest";
import { HttpControllerClient } from "./controller-client.js";

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
