import {
	CookieJar,
	csrfHeaders,
	loginAs,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { type FakeAgent, startFakeAgent } from "../testing/fake-agent/index.js";
import { buildTestServer, PUBLIC_URL } from "../testing/test-support.js";

/**
 * A new chat starts with the picker values the owner last used in that
 * project, kept for each agent; a last-used Bypass or Full access comes back
 * as the agent's default mode (SPEC.md §10.8).
 */

const skip = !hasTestDb();
const AGENT_TOKEN = "fake-agent-token";

let testDb: TestDb;
let mock: MockOidcProvider;
let agent: FakeAgent;
let app: FastifyInstance;
let alice: CookieJar;
let workspaceId: string;

beforeAll(async () => {
	if (skip) return;
	testDb = await createTestDb();
	mock = await startMockOidcProvider({ redirectUris: [`${PUBLIC_URL}/auth/callback`] });
	agent = await startFakeAgent(AGENT_TOKEN);
});

afterAll(async () => {
	if (skip) return;
	await testDb.close();
	await mock.close();
	await agent.close();
});

beforeEach(async () => {
	if (skip) return;
	await testDb.truncate();
	agent.projects.clear();
	app = buildTestServer(testDb.db, mock.issuer, { AGENT_PORT: agent.port });
	await app.listen({ port: 0, host: "127.0.0.1" });
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
			agent_token: AGENT_TOKEN,
			updated_at: new Date().toISOString(),
		})
		.where("id", "=", workspaceId)
		.execute();
	return async () => {
		await app.close();
	};
});

async function newProject(name: string): Promise<string> {
	const created = await app.inject({
		method: "POST",
		url: `/workspaces/${workspaceId}/projects`,
		headers: csrfHeaders(alice, PUBLIC_URL),
		payload: { name, source: "new" },
	});
	return created.json().id;
}

function url(projectId: string): string {
	return `/workspaces/${workspaceId}/projects/${projectId}/chat-settings`;
}

function read(jar: CookieJar, projectId: string) {
	return app.inject({
		method: "GET",
		url: url(projectId),
		headers: { cookie: jar.cookieHeader() },
	});
}

function save(jar: CookieJar, projectId: string, payload: unknown) {
	return app.inject({
		method: "PUT",
		url: url(projectId),
		headers: csrfHeaders(jar, PUBLIC_URL),
		payload: payload as Record<string, unknown>,
	});
}

test.skipIf(skip)("settings are kept per project and read back", async () => {
	const one = await newProject("one");
	const two = await newProject("two");
	expect((await read(alice, one)).statusCode).toBe(204);

	const saved = await save(alice, one, {
		model: "opus",
		effort: "low",
		mode: "acceptEdits",
	});
	expect(saved.statusCode).toBe(204);

	const back = await read(alice, one);
	expect(back.statusCode).toBe(200);
	expect(back.headers["cache-control"]).toBe("no-store");
	expect(back.json()).toEqual({
		model: "opus",
		effort: "low",
		mode: "acceptEdits",
		readAloud: false,
	});
	expect((await read(alice, two)).statusCode).toBe(204);
});

test.skipIf(skip)("a last-used Bypass comes back as Auto", async () => {
	const one = await newProject("one");
	await save(alice, one, { model: "opus", effort: "high", mode: "bypassPermissions" });
	expect((await read(alice, one)).json()).toEqual({
		model: "opus",
		effort: "high",
		mode: "auto",
		readAloud: false,
	});
	const row = await testDb.db
		.selectFrom("projects")
		.select("chat_settings")
		.where("id", "=", one)
		.executeTakeFirstOrThrow();
	expect(row.chat_settings).toEqual({
		model: "opus",
		effort: "high",
		mode: "auto",
		readAloud: false,
	});
});

test.skipIf(skip)(
	"a stored value that cannot be read comes back as the value a new chat starts with",
	async () => {
		const one = await newProject("one");
		await testDb.db
			.updateTable("projects")
			.set({
				chat_settings: JSON.stringify({
					model: "Retired Model",
					effort: "Huge!",
					mode: "low mode",
				}),
			})
			.where("id", "=", one)
			.execute();
		expect((await read(alice, one)).json()).toEqual({
			model: "opus",
			effort: "medium",
			mode: "auto",
			readAloud: false,
		});
	},
);

test.skipIf(skip)("anything but the three values is refused", async () => {
	const one = await newProject("one");
	for (const payload of [
		{ model: "GPT 4", effort: "low", mode: "auto" },
		{ model: "opus", effort: "low" },
		{ model: "opus", effort: "low", mode: "auto", prompt: "hello" },
	]) {
		expect((await save(alice, one, payload)).statusCode).toBe(400);
	}
	expect((await read(alice, one)).statusCode).toBe(204);
});

test.skipIf(skip)("another student gets 404 and changes nothing", async () => {
	const one = await newProject("one");
	const bob = new CookieJar();
	await loginAs(app, "bob", bob);
	expect((await read(bob, one)).statusCode).toBe(404);
	expect(
		(await save(bob, one, { model: "opus", effort: "low", mode: "auto" })).statusCode,
	).toBe(404);
	expect((await read(alice, one)).statusCode).toBe(204);
});

test.skipIf(skip)(
	"read aloud is kept beside the pickers, and each leaves the other",
	async () => {
		const one = await newProject("one");
		// Saved before any picker value: the pickers read as a new chat starts.
		expect((await save(alice, one, { readAloud: true })).statusCode).toBe(204);
		expect((await read(alice, one)).json()).toEqual({
			model: "opus",
			effort: "medium",
			mode: "auto",
			readAloud: true,
		});

		// A picker change that says nothing of read aloud keeps it.
		await save(alice, one, { model: "opus", effort: "low", mode: "plan" });
		expect((await read(alice, one)).json()).toEqual({
			model: "opus",
			effort: "low",
			mode: "plan",
			readAloud: true,
		});

		// Turning it off keeps the picker values.
		await save(alice, one, { readAloud: false });
		expect((await read(alice, one)).json()).toEqual({
			model: "opus",
			effort: "low",
			mode: "plan",
			readAloud: false,
		});

		// The full form may carry it too.
		await save(alice, one, {
			model: "haiku",
			effort: "max",
			mode: "auto",
			readAloud: true,
		});
		expect((await read(alice, one)).json()).toEqual({
			model: "haiku",
			effort: "max",
			mode: "auto",
			readAloud: true,
		});
	},
);

test.skipIf(skip)("read aloud is kept per project", async () => {
	const one = await newProject("one");
	const two = await newProject("two");
	await save(alice, one, { readAloud: true });
	expect((await read(alice, two)).statusCode).toBe(204);
});

test.skipIf(skip)(
	"read aloud must be true or false, alone or with nothing else",
	async () => {
		const one = await newProject("one");
		for (const payload of [
			{ readAloud: "yes" },
			{ readAloud: true, model: "opus" },
			{ readAloud: true, prompt: "hello" },
			{},
		]) {
			expect((await save(alice, one, payload)).statusCode).toBe(400);
		}
		expect((await read(alice, one)).statusCode).toBe(204);
	},
);

const CODEX_ON_REQUEST = { model: "gpt-5.5", effort: "ultra", mode: "onRequest" };

/** What a Codex chat sends: the flat keys are Claude's, the agent's own are under `codex`. */
function codexSave(
	codex: object,
	claude = { model: "opus", effort: "low", mode: "plan" },
) {
	return { ...claude, agent: "codex", codex };
}

test.skipIf(skip)(
	"each agent keeps its own picker values, and agent says which was used last",
	async () => {
		const one = await newProject("one");
		await save(alice, one, { model: "opus", effort: "low", mode: "plan" });
		expect((await read(alice, one)).json()).not.toHaveProperty("agent");

		// A Codex chat's save changes `codex` and `agent`, never Claude's keys,
		// whatever flat keys the body carries.
		expect(
			(
				await save(
					alice,
					one,
					codexSave(CODEX_ON_REQUEST, {
						model: "haiku",
						effort: "max",
						mode: "default",
					}),
				)
			).statusCode,
		).toBe(204);
		expect((await read(alice, one)).json()).toEqual({
			model: "opus",
			effort: "low",
			mode: "plan",
			readAloud: false,
			agent: "codex",
			codex: CODEX_ON_REQUEST,
		});

		// A later Claude save keeps Codex's values and makes Claude the last agent.
		await save(alice, one, { model: "sonnet", effort: "high", mode: "acceptEdits" });
		expect((await read(alice, one)).json()).toEqual({
			model: "sonnet",
			effort: "high",
			mode: "acceptEdits",
			readAloud: false,
			codex: CODEX_ON_REQUEST,
		});

		// Said outright, Claude is the same as absent.
		await save(alice, one, codexSave({ ...CODEX_ON_REQUEST, effort: "low" }));
		await save(alice, one, {
			model: "sonnet",
			effort: "high",
			mode: "acceptEdits",
			agent: "claude",
		});
		const back = (await read(alice, one)).json();
		expect(back).not.toHaveProperty("agent");
		expect(back.codex).toEqual({ ...CODEX_ON_REQUEST, effort: "low" });
	},
);

test.skipIf(skip)(
	"a Codex save keeps read aloud, and read aloud keeps both agents",
	async () => {
		const one = await newProject("one");
		await save(alice, one, { readAloud: true });
		await save(alice, one, codexSave(CODEX_ON_REQUEST));
		await save(alice, one, { readAloud: false });
		expect((await read(alice, one)).json()).toMatchObject({
			readAloud: false,
			agent: "codex",
			codex: CODEX_ON_REQUEST,
		});
	},
);

test.skipIf(skip)("a last-used Codex Full access comes back as Auto", async () => {
	const one = await newProject("one");
	await save(alice, one, codexSave({ ...CODEX_ON_REQUEST, mode: "fullAccess" }));
	const row = await testDb.db
		.selectFrom("projects")
		.select("chat_settings")
		.where("id", "=", one)
		.executeTakeFirstOrThrow();
	expect(row.chat_settings).toMatchObject({
		codex: { ...CODEX_ON_REQUEST, mode: "onRequest" },
	});
	expect((await read(alice, one)).json().codex.mode).toBe("onRequest");

	// A row written some other way is reset on the way out as well.
	await testDb.db
		.updateTable("projects")
		.set({
			chat_settings: JSON.stringify({
				model: "opus",
				effort: "low",
				mode: "bypassPermissions",
				agent: "codex",
				codex: { ...CODEX_ON_REQUEST, mode: "fullAccess" },
			}),
		})
		.where("id", "=", one)
		.execute();
	expect((await read(alice, one)).json()).toMatchObject({
		mode: "auto",
		codex: { ...CODEX_ON_REQUEST, mode: "onRequest" },
	});
});

test.skipIf(skip)("other Codex modes are carried as they were", async () => {
	const one = await newProject("one");
	for (const mode of ["untrusted", "readOnly", "plan", "onRequest"]) {
		await save(alice, one, codexSave({ ...CODEX_ON_REQUEST, mode }));
		expect((await read(alice, one)).json().codex.mode).toBe(mode);
	}
});

test.skipIf(skip)(
	"a stored Codex object that cannot be read, or an unknown agent, reads as absent",
	async () => {
		const one = await newProject("one");
		await testDb.db
			.updateTable("projects")
			.set({
				chat_settings: JSON.stringify({
					model: "opus",
					effort: "low",
					mode: "plan",
					agent: "gemini",
					codex: { model: "GPT 5", effort: "ultra", mode: "onRequest" },
				}),
			})
			.where("id", "=", one)
			.execute();
		const back = (await read(alice, one)).json();
		expect(back).not.toHaveProperty("agent");
		expect(back).not.toHaveProperty("codex");
	},
);

test.skipIf(skip)(
	"a Codex save needs its codex values, and only well-formed ones",
	async () => {
		const one = await newProject("one");
		for (const payload of [
			{ model: "opus", effort: "low", mode: "plan", agent: "codex" },
			codexSave({ model: "GPT 5", effort: "low", mode: "onRequest" }),
			codexSave({ model: "gpt-5.5", effort: "low" }),
			codexSave({ ...CODEX_ON_REQUEST, prompt: "hello" }),
			{ model: "opus", effort: "low", mode: "plan", agent: "gemini" },
		]) {
			expect((await save(alice, one, payload)).statusCode).toBe(400);
		}
		expect((await read(alice, one)).statusCode).toBe(204);
	},
);

test.skipIf(skip)(
	"another student cannot change a project's Codex values",
	async () => {
		const one = await newProject("one");
		const bob = new CookieJar();
		await loginAs(app, "bob", bob);
		expect((await save(bob, one, codexSave(CODEX_ON_REQUEST))).statusCode).toBe(404);
		expect((await read(alice, one)).statusCode).toBe(204);
	},
);
