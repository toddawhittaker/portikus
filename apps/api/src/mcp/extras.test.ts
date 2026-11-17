import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createApiKey } from "@portikus/auth";
import {
	CookieJar,
	loginAs,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import type { ApiKeyScope } from "@portikus/contracts";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { GUIDE_FILES } from "../assistant/guides.js";
import {
	buildTestServer,
	MATRIX_MOCK_USERS,
	PUBLIC_URL,
} from "../testing/test-support.js";
import { RESULTS_ARE_DATA } from "./server.js";

/**
 * MCP resources and prompts (SPEC.md section 20.4): a key lists and reads only
 * the guides its owner's role may read, health only when its owner may run
 * `health.get`, and the prompts whose operations it may run.
 */

const skip = !hasTestDb();

let testDb: TestDb;
let mock: MockOidcProvider;
let app: FastifyInstance;
let base: string;

beforeAll(async () => {
	if (skip) return;
	testDb = await createTestDb();
	mock = await startMockOidcProvider({
		users: MATRIX_MOCK_USERS,
		redirectUris: [`${PUBLIC_URL}/auth/callback`],
	});
});

afterAll(async () => {
	if (skip) return;
	await testDb.close();
	await mock.close();
});

beforeEach(async () => {
	if (skip) return;
	await testDb.truncate();
	await testDb.db
		.insertInto("settings")
		.values({ id: 1, shutdown_grace_seconds: 900 })
		.onConflict((oc) => oc.doNothing())
		.execute();
	app = buildTestServer(testDb.db, mock.issuer);
	base = await app.listen({ port: 0, host: "127.0.0.1" });
	return async () => {
		await app.close();
	};
});

async function keyFor(user: string, scope: ApiKeyScope = "read"): Promise<string> {
	const jar = new CookieJar();
	await loginAs(app, user, jar);
	const me = await app.inject({
		method: "GET",
		url: "/auth/me",
		headers: { cookie: jar.cookieHeader() },
	});
	const made = await createApiKey(testDb.db, me.json().id, {
		name: `${scope} key`,
		scope,
		periodDays: 30,
	});
	if (!made.ok) throw new Error(`no key: ${made.reason}`);
	return made.secret;
}

async function withClient<T>(
	secret: string,
	use: (client: Client) => Promise<T>,
): Promise<T> {
	const client = new Client({ name: "portikus-test", version: "1.0.0" });
	await client.connect(
		new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
			requestInit: { headers: { authorization: `Bearer ${secret}` } },
		}),
	);
	try {
		return await use(client);
	} finally {
		await client.close();
	}
}

const guideUris = (files: readonly string[]) =>
	files.map((file) => `portikus://guides/${file}`).sort();

/** The one text message a rendered prompt holds. */
function promptText(prompt: { messages: { content: unknown }[] }): string {
	const content = prompt.messages[0]?.content as { text?: string } | undefined;
	return content?.text ?? "";
}

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const COURSE = "22222222-2222-4222-8222-222222222222";

describe.skipIf(skip)("resources", () => {
	test("an administrator lists every guide and health, and reads them", async () => {
		const secret = await keyFor("carol");
		await withClient(secret, async (client) => {
			const { resources } = await client.listResources();
			const uris = resources.map((one) => one.uri).sort();
			expect(uris).toEqual([...guideUris(GUIDE_FILES), "portikus://health"].sort());

			const guide = await client.readResource({
				uri: "portikus://guides/ADMIN-GUIDE.md",
			});
			const content = guide.contents[0] as { text: string; mimeType?: string };
			expect(content.mimeType).toBe("text/markdown");
			expect(content.text.length).toBeGreaterThan(1000);

			const health = await client.readResource({ uri: "portikus://health" });
			const report = health.contents[0] as { text: string; mimeType?: string };
			expect(report.mimeType).toBe("application/json");
			expect(JSON.parse(report.text)).toEqual(expect.any(Object));
		});
	});

	test("an instructor lists only the instructor guide and no health", async () => {
		const secret = await keyFor("ivy");
		await withClient(secret, async (client) => {
			const { resources } = await client.listResources();
			expect(resources.map((one) => one.uri)).toEqual([
				"portikus://guides/INSTRUCTOR-GUIDE.md",
			]);
			const guide = await client.readResource({
				uri: "portikus://guides/INSTRUCTOR-GUIDE.md",
			});
			expect((guide.contents[0] as { text: string }).text.length).toBeGreaterThan(100);
		});
	});

	test("an instructor cannot read an administrator guide or health", async () => {
		const secret = await keyFor("ivy");
		await withClient(secret, async (client) => {
			await expect(
				client.readResource({ uri: "portikus://guides/ADMIN-GUIDE.md" }),
			).rejects.toThrow(/not found/i);
			await expect(client.readResource({ uri: "portikus://health" })).rejects.toThrow(
				/not found/i,
			);
		});
	});

	test("an unknown resource fails with a message, not a crash", async () => {
		const secret = await keyFor("carol");
		await withClient(secret, async (client) => {
			await expect(
				client.readResource({ uri: "portikus://guides/NOPE.md" }),
			).rejects.toThrow(/not found/i);
			await expect(
				client.readResource({ uri: "portikus://guides/../secrets" }),
			).rejects.toThrow();
			// The server still answers afterwards.
			expect((await client.listResources()).resources.length).toBeGreaterThan(0);
		});
	});

	test("reading health is audited as the key's own request", async () => {
		const secret = await keyFor("carol");
		await withClient(secret, (client) =>
			client.readResource({ uri: "portikus://health" }),
		);
		// The gate writes its row when the response is done, which can be just after the answer.
		const row = await vi.waitFor(
			async () => {
				const rows = await testDb.db
					.selectFrom("audit_events")
					.select(["result", "via", "metadata"])
					.where("action", "=", "api_key.used")
					.execute();
				const found = rows.find(
					(one) => (one.metadata as { operation?: string }).operation === "health.get",
				);
				if (!found) throw new Error("no api_key.used row for health.get yet");
				return found;
			},
			{ timeout: 5000, interval: 25 },
		);
		expect(row).toMatchObject({ result: "ok", via: "api_key" });
	});
});

describe.skipIf(skip)("prompts", () => {
	test("an administrator lists the two diagnose prompts and renders them", async () => {
		const secret = await keyFor("carol");
		await withClient(secret, async (client) => {
			const { prompts } = await client.listPrompts();
			const names = prompts.map((one) => one.name);
			expect(names).toContain("diagnose_workspace");
			expect(names).toContain("diagnose_health");
			expect(names).not.toContain("who_is_stuck");

			const workspace = await client.getPrompt({
				name: "diagnose_workspace",
				arguments: { workspace: WORKSPACE },
			});
			const text = promptText(workspace);
			expect(text).toContain("workspaces.get_detail");
			expect(text).toContain(WORKSPACE);
			expect(text).toContain("workspaces.agent_log");
			expect(text).toContain(RESULTS_ARE_DATA);

			const health = await client.getPrompt({ name: "diagnose_health" });
			const healthText = promptText(health);
			expect(healthText).toContain("health.get");
			expect(healthText).toContain("logs.list");
		});
	});

	test("a workspace that is not an id is refused", async () => {
		const secret = await keyFor("carol");
		await withClient(secret, async (client) => {
			await expect(
				client.getPrompt({
					name: "diagnose_workspace",
					arguments: { workspace: "../../etc" },
				}),
			).rejects.toThrow(/id/);
		});
	});

	test("an instructor sees who_is_stuck and no administrator prompt", async () => {
		const secret = await keyFor("ivy");
		await withClient(secret, async (client) => {
			const { prompts } = await client.listPrompts();
			expect(prompts.map((one) => one.name)).toEqual(["who_is_stuck"]);

			const stuck = await client.getPrompt({
				name: "who_is_stuck",
				arguments: { course: COURSE },
			});
			const text = promptText(stuck);
			expect(text).toContain("courses.stuck");
			expect(text).toContain(COURSE);

			await expect(client.getPrompt({ name: "diagnose_health" })).rejects.toThrow();
			await expect(
				client.getPrompt({
					name: "who_is_stuck",
					arguments: { course: "not-an-id" },
				}),
			).rejects.toThrow(/id/);
		});
	});
});
