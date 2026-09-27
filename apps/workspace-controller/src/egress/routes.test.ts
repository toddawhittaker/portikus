import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { FakeWorkspaceProvider } from "../fake-provider.js";
import { buildServer } from "../server.js";

const TOKEN = "t".repeat(32);
const auth = { authorization: `Bearer ${TOKEN}` };

let dir: string;
let app: FastifyInstance;
let requestPath: string;
let stateDir: string;
let helper: ReturnType<typeof setInterval> | null;

const body = {
	version: 5,
	mode: "allow-list",
	names: ["github.com"],
	ranges: [],
	ports: [22, 80, 443],
};

/** Plays the root helper: answers each request file with the given outcome. */
function fakeHelper(outcome: { ok: boolean; error?: string }): void {
	helper = setInterval(() => {
		if (!existsSync(requestPath)) return;
		const req = JSON.parse(readFileSync(requestPath, "utf8"));
		writeFileSync(join(stateDir, "request.seen"), JSON.stringify(req));
		if (outcome.ok) {
			writeFileSync(
				join(stateDir, "applied.json"),
				JSON.stringify({
					policy: { ...req, requestId: undefined },
					appliedAt: "2026-09-27T12:00:00.000Z",
				}),
			);
		}
		writeFileSync(
			join(stateDir, "status.json"),
			JSON.stringify({
				requestId: req.requestId,
				version: req.version,
				ok: outcome.ok,
				error: outcome.error ?? null,
				at: "2026-09-27T12:00:00.000Z",
			}),
		);
		// The helper moves the request aside; this fake just removes it.
		rmSync(requestPath);
	}, 10);
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "egress-routes-"));
	mkdirSync(join(dir, "request"));
	mkdirSync(join(dir, "state"));
	requestPath = join(dir, "request", "request.json");
	stateDir = join(dir, "state");
	helper = null;
	app = buildServer({
		provider: new FakeWorkspaceProvider(),
		token: TOKEN,
		egress: { requestPath, stateDir, timeoutMs: 400, pollMs: 20 },
	});
});

afterEach(async () => {
	if (helper) clearInterval(helper);
	await app.close();
});

describe("PUT /egress-policy (ADR 0038)", () => {
	test("writes the request for the helper and answers with what applied", async () => {
		fakeHelper({ ok: true });
		const res = await app.inject({
			method: "PUT",
			url: "/egress-policy",
			headers: auth,
			payload: body,
		});
		expect(res.statusCode).toBe(200);
		expect(res.json()).toEqual({
			appliedVersion: 5,
			appliedAt: "2026-09-27T12:00:00.000Z",
			error: null,
		});
		const seen = JSON.parse(readFileSync(join(stateDir, "request.seen"), "utf8"));
		expect(seen).toMatchObject(body);
		expect(seen.requestId).toMatch(/^[0-9a-f-]{36}$/);
	});

	test("the request file is not world-readable", async () => {
		const res = app.inject({
			method: "PUT",
			url: "/egress-policy",
			headers: auth,
			payload: body,
		});
		await new Promise((r) => setTimeout(r, 60));
		expect(statSync(requestPath).mode & 0o007).toBe(0);
		await res;
	});

	test("the helper's error is passed on as 500", async () => {
		fakeHelper({ ok: false, error: "nft refused the table: boom" });
		const res = await app.inject({
			method: "PUT",
			url: "/egress-policy",
			headers: auth,
			payload: body,
		});
		expect(res.statusCode).toBe(500);
		expect(res.json()).toEqual({
			code: "OPERATION_FAILED",
			message: "nft refused the table: boom",
		});
	});

	test("no answer within the wait is a timeout", async () => {
		const res = await app.inject({
			method: "PUT",
			url: "/egress-policy",
			headers: auth,
			payload: body,
		});
		expect(res.statusCode).toBe(504);
		expect(res.json().code).toBe("TIMEOUT");
	});

	test("a status for another request is not taken as the answer", async () => {
		writeFileSync(
			join(stateDir, "status.json"),
			JSON.stringify({ requestId: "old", version: 5, ok: true, error: null, at: "x" }),
		);
		const res = await app.inject({
			method: "PUT",
			url: "/egress-policy",
			headers: auth,
			payload: body,
		});
		expect(res.statusCode).toBe(504);
	});

	test.each([
		["a name with a newline", { ...body, names: ["a.com\nserver=/#/1.1.1.1"] }],
		["a denied range", { ...body, ranges: ["10.0.0.0/8"] }],
		["an extra key", { ...body, requestId: "mine" }],
		["no version", { ...body, version: undefined }],
	])("refuses %s without writing a request", async (_what, payload) => {
		const res = await app.inject({
			method: "PUT",
			url: "/egress-policy",
			headers: auth,
			payload,
		});
		expect(res.statusCode).toBe(400);
		expect(existsSync(requestPath)).toBe(false);
	});

	test("needs the controller token", async () => {
		const res = await app.inject({
			method: "PUT",
			url: "/egress-policy",
			payload: body,
		});
		expect(res.statusCode).toBe(401);
		expect(existsSync(requestPath)).toBe(false);
	});
});

describe("GET /egress-policy", () => {
	test("nothing applied yet", async () => {
		const res = await app.inject({
			method: "GET",
			url: "/egress-policy",
			headers: auth,
		});
		expect(res.json()).toEqual({ appliedVersion: null, appliedAt: null, error: null });
	});

	test("the applied version and the last error", async () => {
		writeFileSync(
			join(stateDir, "applied.json"),
			JSON.stringify({
				policy: { ...body, version: 4 },
				appliedAt: "2026-09-27T11:00:00.000Z",
			}),
		);
		writeFileSync(
			join(stateDir, "status.json"),
			JSON.stringify({ requestId: "r", version: 5, ok: false, error: "bad", at: "x" }),
		);
		const res = await app.inject({
			method: "GET",
			url: "/egress-policy",
			headers: auth,
		});
		expect(res.json()).toEqual({
			appliedVersion: 4,
			appliedAt: "2026-09-27T11:00:00.000Z",
			error: "bad",
		});
	});
});
