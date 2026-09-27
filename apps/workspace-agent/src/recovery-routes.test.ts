/**
 * The agent's recovery routes over HTTP (SPEC.md §15, §24.6; ADR 0020):
 * the token, uuid checks before any path is built, status codes, a full
 * volume becoming STORAGE_FULL with no file left behind, and no file names
 * in the logs.
 */
import { randomUUID } from "node:crypto";
import type * as FsPromises from "node:fs/promises";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { AgentCreateRecoveryPointResponse } from "@portikus/contracts";
import { collectingLogger } from "@portikus/observability/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { buildServer } from "./server.js";

/** When set, the next `.partial` archive fails as a full disk would. */
const failNextPartial = { on: false };

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof FsPromises>();
	const open: typeof actual.open = async (...args) => {
		const handle = await actual.open(...args);
		if (failNextPartial.on && String(args[0]).endsWith(".partial")) {
			failNextPartial.on = false;
			handle.createWriteStream = () =>
				new Writable({
					write(_chunk, _encoding, callback) {
						callback(Object.assign(new Error("no space left"), { code: "ENOSPC" }));
					},
				}) as ReturnType<typeof handle.createWriteStream>;
		}
		return handle;
	};
	return { ...actual, open };
});

const TOKEN = "b".repeat(64);
const headers = { authorization: `Bearer ${TOKEN}` };

let app: FastifyInstance;
let base: string;
let homeDir: string;
let recoveryRoot: string;
const logs = collectingLogger("debug");

beforeAll(async () => {
	base = await mkdtemp(join(tmpdir(), "portikus-recovery-routes-"));
	homeDir = join(base, "home");
	recoveryRoot = join(base, "recovery");
	await mkdir(homeDir);
	await mkdir(recoveryRoot, { mode: 0o700 });
	const tokenPath = join(base, "agent.token");
	await writeFile(tokenPath, `${TOKEN}\n`, { mode: 0o600 });
	app = buildServer({
		tmuxSocketName: "portikus-test",
		tokenPath,
		homeDir,
		recoveryRoot,
		logger: logs.logger,
		listening: {
			procRoot: base,
			interfaceAddress: null,
			docker: null,
			intervalMs: 60_000,
		},
	});
	await app.ready();
});

afterAll(async () => {
	await app.close();
	await rm(base, { recursive: true, force: true });
});

beforeEach(async () => {
	await rm(join(homeDir, "projects"), { recursive: true, force: true });
	await mkdir(join(homeDir, "projects", "alpha", "src"), { recursive: true });
	await writeFile(
		join(homeDir, "projects", "alpha", "src", "private-name.txt"),
		"v1\n",
	);
});

function create(payload: Record<string, unknown>, slug = "alpha") {
	return app.inject({
		method: "POST",
		url: `/projects/${slug}/recovery-points`,
		headers,
		payload,
	});
}

test("every recovery route needs the token", async () => {
	const projectId = randomUUID();
	const pointId = randomUUID();
	for (const [method, url] of [
		["POST", "/projects/alpha/recovery-points"],
		["POST", `/projects/alpha/recovery-points/${pointId}/restore`],
		["DELETE", `/recovery-points/${projectId}/${pointId}`],
		["DELETE", `/recovery-points/${projectId}`],
	] as const) {
		const response = await app.inject({ method, url, payload: {} });
		expect(response.statusCode).toBe(401);
	}
});

test("create answers 201 with the hash, then 200 and nothing written when unchanged", async () => {
	const projectId = randomUUID();
	const first = await create({ projectId, pointId: randomUUID() });
	expect(first.statusCode).toBe(201);
	const body = AgentCreateRecoveryPointResponse.parse(first.json());
	if (!body.created) throw new Error("expected a point");

	const second = await create({
		projectId,
		pointId: randomUUID(),
		skipIfFingerprint: body.fingerprint,
	});
	expect(second.statusCode).toBe(200);
	expect(second.json()).toEqual({ created: false, fingerprint: body.fingerprint });
	expect(await readdir(join(recoveryRoot, projectId))).toHaveLength(1);
});

test("ids that are not uuids are refused before any path is built", async () => {
	expect((await create({ projectId: "../x", pointId: randomUUID() })).statusCode).toBe(
		400,
	);
	expect((await create({ projectId: randomUUID(), pointId: "p" })).statusCode).toBe(
		400,
	);
	const restore = await app.inject({
		method: "POST",
		url: "/projects/alpha/recovery-points/..%2F..%2Fx/restore",
		headers,
		payload: { projectId: randomUUID(), sha256: "a".repeat(64) },
	});
	expect(restore.statusCode).toBe(400);
	const del = await app.inject({
		method: "DELETE",
		url: "/recovery-points/not-a-uuid",
		headers,
	});
	expect(del.statusCode).toBe(400);
	const delOne = await app.inject({
		method: "DELETE",
		url: `/recovery-points/${randomUUID()}/nope`,
		headers,
	});
	expect(delOne.statusCode).toBe(400);
});

test("an unknown project is 404", async () => {
	const response = await create(
		{ projectId: randomUUID(), pointId: randomUUID() },
		"nope",
	);
	expect(response.statusCode).toBe(404);
	expect(response.json().error.code).toBe("PROJECT_NOT_FOUND");
});

test("a full recovery volume is STORAGE_FULL and leaves no partial file", async () => {
	const projectId = randomUUID();
	failNextPartial.on = true;
	const response = await create({ projectId, pointId: randomUUID() });
	expect(response.statusCode).toBe(507);
	expect(response.json().error.code).toBe("STORAGE_FULL");
	expect(await readdir(join(recoveryRoot, projectId))).toEqual([]);
});

test("restore puts the point back and answers 204; a bad hash is 422", async () => {
	const projectId = randomUUID();
	const pointId = randomUUID();
	const made = AgentCreateRecoveryPointResponse.parse(
		(await create({ projectId, pointId })).json(),
	);
	if (!made.created) throw new Error("expected a point");
	const file = join(homeDir, "projects", "alpha", "src", "private-name.txt");
	await writeFile(file, "v2\n");

	const refused = await app.inject({
		method: "POST",
		url: `/projects/alpha/recovery-points/${pointId}/restore`,
		headers,
		payload: { projectId, sha256: "f".repeat(64) },
	});
	expect(refused.statusCode).toBe(422);
	expect(refused.json().error.code).toBe("RECOVERY_POINT_INVALID");
	expect(await readFile(file, "utf8")).toBe("v2\n");

	const restored = await app.inject({
		method: "POST",
		url: `/projects/alpha/recovery-points/${pointId}/restore`,
		headers,
		payload: { projectId, sha256: made.sha256 },
	});
	expect(restored.statusCode).toBe(204);
	expect(await readFile(file, "utf8")).toBe("v1\n");
});

test("delete removes one point, then the whole project directory", async () => {
	const projectId = randomUUID();
	const first = randomUUID();
	const second = randomUUID();
	await create({ projectId, pointId: first });
	await writeFile(join(homeDir, "projects", "alpha", "more.txt"), "x\n");
	await create({ projectId, pointId: second });

	const one = await app.inject({
		method: "DELETE",
		url: `/recovery-points/${projectId}/${first}`,
		headers,
	});
	expect(one.statusCode).toBe(204);
	expect(await readdir(join(recoveryRoot, projectId))).toEqual([`${second}.tar.zst`]);

	const all = await app.inject({
		method: "DELETE",
		url: `/recovery-points/${projectId}`,
		headers,
	});
	expect(all.statusCode).toBe(204);
	await expect(readdir(join(recoveryRoot, projectId))).rejects.toThrow();
});

test("both deletes answer 204 when the point or the project directory is already gone", async () => {
	// Retention deletes the file, then the row; a retry must not keep the row.
	const projectId = randomUUID();
	const pointId = randomUUID();
	await create({ projectId, pointId });
	for (let attempt = 0; attempt < 2; attempt++) {
		const one = await app.inject({
			method: "DELETE",
			url: `/recovery-points/${projectId}/${pointId}`,
			headers,
		});
		expect(one.statusCode).toBe(204);
	}
	for (let attempt = 0; attempt < 2; attempt++) {
		const all = await app.inject({
			method: "DELETE",
			url: `/recovery-points/${projectId}`,
			headers,
		});
		expect(all.statusCode).toBe(204);
	}
	// A project that never had a point, and a point in it.
	const never = randomUUID();
	for (const url of [
		`/recovery-points/${never}/${randomUUID()}`,
		`/recovery-points/${never}`,
	]) {
		expect((await app.inject({ method: "DELETE", url, headers })).statusCode).toBe(204);
	}
});

test("logs carry ids and sizes, never file names", () => {
	const text = JSON.stringify(logs.lines);
	expect(text).toContain("recovery point created");
	expect(text).not.toContain("private-name");
});
