import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CookieJar,
	csrfHeaders,
	loginAs,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
// @ts-expect-error apps/api does not depend on the agent package; the vitest
// alias in vitest.config.ts resolves it from source for this test only.
import { buildServer as buildAgentServer } from "@portikus/workspace-agent";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { buildTestServer, PUBLIC_URL } from "../testing/test-support.js";

/**
 * The API's project, file, Git, search and checks routes in front of the REAL
 * workspace agent, so a change to the wire shape on either side fails here
 * even though the browser tests run against the fake agent (SPEC.md §10,
 * §11, §12, §18.1). Each area has its main path and one refusal the agent
 * itself produces. git, rg, zip and unzip are installed on the CI runner.
 */

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const skip = !hasTestDb();
const TOKEN = "r".repeat(64);

let testDb: TestDb;
let mock: MockOidcProvider;
let app: FastifyInstance;
let agentApp: FastifyInstance;
let home: string;
let agentPort: number;
let alice: CookieJar;
let workspaceId: string;
let projectId: string;

beforeAll(async () => {
	if (skip) return;
	testDb = await createTestDb();
	mock = await startMockOidcProvider({
		redirectUris: [`${PUBLIC_URL}/auth/callback`],
	});
	home = await mkdtemp(join(tmpdir(), "portikus-relay-home-"));
	const tokenPath = join(home, "agent.token");
	await writeFile(tokenPath, `${TOKEN}\n`, { mode: 0o600 });
	agentApp = buildAgentServer({ tokenPath, homeDir: home }) as FastifyInstance;
	await agentApp.listen({ port: 0, host: "127.0.0.1" });
	agentPort = (agentApp.server.address() as AddressInfo).port;
});

afterAll(async () => {
	if (skip) return;
	await agentApp.close();
	await rm(home, { recursive: true, force: true });
	await testDb.close();
	await mock.close();
});

beforeEach(async () => {
	if (skip) return;
	await rm(join(home, "projects"), { recursive: true, force: true });
	await testDb.truncate();
	app = buildTestServer(testDb.db, mock.issuer, { AGENT_PORT: agentPort });
	await app.ready();
	alice = new CookieJar();
	await loginAs(app, "alice", alice);
	workspaceId = (
		await app.inject({
			method: "POST",
			url: "/workspaces",
			headers: csrfHeaders(alice, PUBLIC_URL),
		})
	).json().id;
	await testDb.db
		.updateTable("workspaces")
		.set({
			state: "running",
			agent_address: "127.0.0.1",
			agent_token: TOKEN,
			updated_at: new Date().toISOString(),
		})
		.where("id", "=", workspaceId)
		.execute();
	const created = await send("POST", "", { name: "lab", source: "new", gitInit: true });
	expect(created.statusCode).toBe(201);
	projectId = created.json().id;
	return async () => {
		await app.close();
	};
});

function projectUrl(rest: string): string {
	return `/workspaces/${workspaceId}/projects${rest}`;
}

function send(method: "POST" | "PATCH" | "DELETE", rest: string, payload?: unknown) {
	return app.inject({
		method,
		url: projectUrl(rest),
		headers: csrfHeaders(alice, PUBLIC_URL),
		...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
	});
}

function get(rest: string) {
	return app.inject({
		method: "GET",
		url: projectUrl(rest),
		headers: { cookie: alice.cookieHeader() },
	});
}

function writeText(path: string, body: string, condition: Record<string, string>) {
	return app.inject({
		method: "PUT",
		url: projectUrl(`/${projectId}/file?path=${encodeURIComponent(path)}`),
		headers: {
			...csrfHeaders(alice, PUBLIC_URL),
			"content-type": "text/plain",
			...condition,
		},
		payload: body,
	});
}

function labDir(): string {
	return join(home, "projects", "lab");
}

describe.skipIf(skip)("projects", () => {
	test("create, list, rename and duplicate reach the real directories", async () => {
		const listed = await get("");
		expect(listed.statusCode).toBe(200);
		const lab = listed
			.json()
			.projects.find((one: { id: string }) => one.id === projectId);
		expect(lab).toMatchObject({ name: "lab", slug: "lab" });

		const renamed = await send("PATCH", `/${projectId}`, { name: "Lab Two" });
		expect(renamed.statusCode).toBe(200);
		const slug = renamed.json().slug as string;
		await expect(
			readFile(join(home, "projects", slug, ".git", "HEAD"), "utf8"),
		).resolves.toContain("ref:");

		const copy = await send("POST", `/${projectId}/duplicate`, { name: "copy" });
		expect(copy.statusCode).toBe(201);
		expect(copy.json()).toMatchObject({ name: "copy", slug: "copy" });
		await expect(
			readFile(join(home, "projects", "copy", ".git", "HEAD"), "utf8"),
		).resolves.toContain("ref:");
	});

	test("a duplicate onto a directory the agent already has is the agent's 409", async () => {
		// The directory exists on disk but not yet in the control plane's rows,
		// so only the agent can refuse.
		await mkdir(join(home, "projects", "taken"), { recursive: true });
		const response = await send("POST", `/${projectId}/duplicate`, { name: "taken" });
		expect(response.statusCode).toBe(409);
		expect(response.json().code).toBe("PROJECT_EXISTS");
	});
});

describe.skipIf(skip)("files", () => {
	test("write, read, list, make a folder, move, download and delete", async () => {
		const written = await writeText("notes.md", "# Notes\n", { "if-none-match": "*" });
		expect(written.statusCode).toBe(200);
		const { etag, size } = written.json();
		expect(size).toBe(8);
		expect(await readFile(join(labDir(), "notes.md"), "utf8")).toBe("# Notes\n");

		const read = await get(`/${projectId}/file?path=notes.md`);
		expect(read.statusCode).toBe(200);
		expect(read.body).toBe("# Notes\n");
		expect(String(read.headers.etag).replaceAll('"', "")).toBe(etag);

		const made = await send("POST", `/${projectId}/mkdir`, { path: "docs" });
		expect(made.statusCode).toBe(201);
		const moved = await send("POST", `/${projectId}/move`, {
			from: "notes.md",
			to: "docs/notes.md",
		});
		expect(moved.statusCode).toBe(204);

		const tree = await get(`/${projectId}/tree?path=docs`);
		expect(tree.statusCode).toBe(200);
		expect(tree.json()).toMatchObject({
			entries: [{ name: "notes.md", type: "file", size: 8 }],
			truncated: false,
		});

		const download = await get(`/${projectId}/download`);
		expect(download.statusCode).toBe(200);
		expect(download.headers["content-type"]).toContain("application/zip");
		expect(download.rawPayload.subarray(0, 2).toString()).toBe("PK");

		const removed = await send("DELETE", `/${projectId}/file?path=docs/notes.md`);
		expect(removed.statusCode).toBe(204);
		expect((await get(`/${projectId}/file?path=docs/notes.md`)).json().code).toBe(
			"FILE_NOT_FOUND",
		);
	});

	test("a write against a stale etag is the agent's 412 with the current etag", async () => {
		const first = await writeText("a.txt", "one", { "if-none-match": "*" });
		const stale = first.json().etag as string;
		await writeFile(join(labDir(), "a.txt"), "changed on disk");
		const response = await writeText("a.txt", "two", { "if-match": `"${stale}"` });
		expect(response.statusCode).toBe(412);
		expect(response.json().code).toBe("FILE_CHANGED");
		expect(response.headers.etag).toBeTruthy();
		expect(String(response.headers.etag)).not.toContain(stale);
	});
});

describe.skipIf(skip)("git", () => {
	test("status and diff of a new file in a real repository", async () => {
		await writeText("hello.txt", "hello\n", { "if-none-match": "*" });
		const status = await get(`/${projectId}/git/status`);
		expect(status.statusCode).toBe(200);
		expect(status.json()).toMatchObject({ repo: true, truncated: false });
		expect(status.json().entries).toEqual(
			expect.arrayContaining([expect.objectContaining({ path: "hello.txt" })]),
		);

		const diff = await get(`/${projectId}/git/diff?path=hello.txt`);
		expect(diff.statusCode).toBe(200);
		expect(diff.json()).toEqual({
			status: "A",
			before: null,
			after: "hello\n",
			binary: false,
			tooLarge: false,
		});
	});

	test("a diff of a directory is the agent's 400", async () => {
		// A missing path is a valid diff at the real agent (the older side may
		// still have it), so a directory is the refusal to pin.
		await mkdir(join(labDir(), "folder"));
		const response = await get(`/${projectId}/git/diff?path=folder`);
		expect(response.statusCode).toBe(400);
		expect(response.json().code).toBe("PATH_INVALID");
	});
});

describe.skipIf(skip)("search", () => {
	test("a literal query finds the line through ripgrep", async () => {
		await writeText("src.txt", "first\nneedle here\nlast\n", { "if-none-match": "*" });
		const response = await get(`/${projectId}/search?q=needle`);
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({
			matches: [
				{
					path: "src.txt",
					line: 2,
					column: 1,
					text: "needle here",
					before: ["first"],
					after: ["last"],
				},
			],
			truncated: false,
		});
	});

	test("a project gone from disk is the agent's 404", async () => {
		await rm(labDir(), { recursive: true, force: true });
		const response = await get(`/${projectId}/search?q=needle`);
		expect(response.statusCode).toBe(404);
		expect(response.json().code).toBe("PROJECT_NOT_FOUND");
	});
});

describe.skipIf(skip)("checks", () => {
	const CHECKS = {
		checks: [{ id: "tests", name: "Tests", command: "echo all good" }],
	};

	test("the checks file is read and a run ends as passed", async () => {
		await mkdir(join(labDir(), ".portikus"), { recursive: true });
		await writeFile(join(labDir(), ".portikus", "checks.json"), JSON.stringify(CHECKS));
		const listed = await get(`/${projectId}/checks`);
		expect(listed.statusCode).toBe(200);
		expect(listed.json()).toEqual({ checks: CHECKS.checks, error: null, runs: [] });

		const started = await send("POST", `/${projectId}/checks/tests/runs`);
		expect(started.statusCode).toBe(201);
		expect(started.json()).toMatchObject({ checkId: "tests" });
		await vi.waitFor(
			async () => {
				const runs = (await get(`/${projectId}/checks`)).json().runs;
				expect(runs).toEqual([
					expect.objectContaining({ checkId: "tests", state: "passed", exitCode: 0 }),
				]);
			},
			{ timeout: 10_000, interval: 100 },
		);
	});

	test("a check the file does not name is the agent's 404", async () => {
		const response = await send("POST", `/${projectId}/checks/nope/runs`);
		expect(response.statusCode).toBe(404);
		expect(response.json().code).toBe("CHECK_NOT_FOUND");
	});
});
