/**
 * The built-in AI settings routes (SPEC.md sections 20.4, 24.1, 24.8, 24.11):
 * administrator only, the key write-only, the privacy notice before turning
 * on, and the proxy host offered with the address. Model calls use the fake
 * client; nothing here reaches a real model.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CookieJar,
	csrfHeaders,
	loginAs,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import {
	AI_NOTICE_VERSION,
	AiSettingsView,
	MAX_PROXY_HOSTS,
	ModelListResponse,
	SiteJobRequest,
	TestAiResult,
} from "@portikus/contracts";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import { createLogger } from "@portikus/observability";
import type { FastifyInstance } from "fastify";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
	vi,
} from "vitest";
import { createFakeModelClient, type FakeStep } from "../ai/fake-model.js";
import type { ModelClient, ModelPart, ModelSettings } from "../ai/model.js";
import { buildTestServer, PUBLIC_URL } from "../testing/test-support.js";

const model = vi.hoisted(() => ({
	client: null as unknown,
	settings: [] as ModelSettings[],
}));

vi.mock("../ai/model.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../ai/model.js")>()),
	createModelClient: (settings: ModelSettings) => {
		model.settings.push(settings);
		return model.client;
	},
}));

const skip = !hasTestDb();
let testDb: TestDb;
let mock: MockOidcProvider;
let dir = "";
let jobsDir = "";
let hostsFile = "";
let operatorFile = "";
let logLines: string[] = [];

const KEY = "fake-provider-key-for-tests-WXYZ";
const BASE = "https://api.openai.com/v1";

beforeAll(async () => {
	if (skip) return;
	testDb = await createTestDb();
	mock = await startMockOidcProvider({ redirectUris: [`${PUBLIC_URL}/auth/callback`] });
});

afterAll(async () => {
	if (skip) return;
	await testDb.close();
	await mock.close();
});

beforeEach(async () => {
	if (skip) return;
	await testDb.truncate();
	await testDb.db.deleteFrom("ai_usage_days").execute();
	await testDb.db
		.updateTable("ai_settings")
		.set({
			enabled: false,
			provider_kind: null,
			base_url: null,
			model: null,
			key_sealed: null,
			key_hint: null,
			monthly_token_cap: 5_000_000,
			conversation_token_budget: 200_000,
			notice_version: null,
			notice_accepted_by: null,
			notice_accepted_at: null,
			price_sources: [],
		})
		.execute();
	dir = await mkdtemp(join(tmpdir(), "admin-ai-"));
	jobsDir = join(dir, "site-jobs");
	hostsFile = join(dir, "proxy-hosts.json");
	operatorFile = join(dir, "operator-proxy-hosts.json");
	await mkdir(jobsDir);
	model.client = null;
	model.settings = [];
	logLines = [];
});

afterEach(async () => {
	if (dir) await rm(dir, { recursive: true, force: true });
});

function server(overrides: Record<string, unknown> = {}): FastifyInstance {
	return buildTestServer(
		testDb.db,
		mock.issuer,
		{
			SITE_JOBS_DIR: jobsDir,
			PROXY_HOSTS_FILE: hostsFile,
			OPERATOR_PROXY_HOSTS_FILE: operatorFile,
			PREVIEW_SUFFIX: "preview.school.edu",
			...overrides,
		},
		createLogger({
			service: "api",
			level: "debug",
			destination: { write: (line: string) => logLines.push(line) },
		}),
	);
}

type Call = (
	method: "GET" | "PUT" | "POST",
	url: string,
	payload?: unknown,
) => Promise<{ statusCode: number; body: string; json: () => unknown }>;

async function as(app: FastifyInstance, who: string): Promise<Call> {
	const jar = new CookieJar();
	await loginAs(app, who, jar);
	return (method, url, payload) =>
		app.inject({
			method,
			url,
			headers: csrfHeaders(jar, PUBLIC_URL),
			...(payload === undefined ? {} : { payload: payload as object }),
		});
}

async function withApp(
	run: (call: Call, app: FastifyInstance) => Promise<void>,
	overrides: Record<string, unknown> = {},
): Promise<void> {
	const app = server(overrides);
	await app.ready();
	try {
		await run(await as(app, "carol"), app);
	} finally {
		await app.close();
	}
}

async function requests(): Promise<string[]> {
	return (await readdir(jobsDir)).filter((n) => n.startsWith("request-"));
}

async function auditRows(action: string) {
	return testDb.db
		.selectFrom("audit_events")
		.selectAll()
		.where("action", "=", action)
		.execute();
}

const FINISH = (input = 10, output = 5): ModelPart => ({
	type: "finish",
	usage: { input, output, cacheRead: 0, cacheWrite: 0 },
});
const PING: ModelPart = {
	type: "tool-call",
	id: "call-1",
	name: "portikus_ping",
	input: { word: "pong" },
};

/** Saved settings a test can call the model with. */
const FULL = {
	providerKind: "openai-compatible",
	baseUrl: BASE,
	model: "gpt-x",
	key: KEY,
} as const;

describe.skipIf(skip)("who may use the AI settings routes", () => {
	test("an administrator only: no session 401, student and instructor 403", async () => {
		const app = server();
		await app.ready();
		try {
			const alice = await as(app, "alice");
			const bob = await as(app, "bob");
			await testDb.db
				.updateTable("users")
				.set({ granted_role: "instructor", role: "instructor" })
				.where("oidc_subject", "=", "bob")
				.execute();
			const routes = [
				["GET", "/admin/ai"],
				["PUT", "/admin/ai"],
				["POST", "/admin/ai/notice"],
				["POST", "/admin/ai/test"],
				["GET", "/admin/ai/models"],
			] as const;
			const origin = { origin: new URL(PUBLIC_URL).origin };
			for (const [method, url] of routes) {
				const none = await app.inject({ method, url, headers: origin });
				expect(none.statusCode, `${method} ${url} anonymous`).toBe(401);
				expect(
					(await alice(method, url, {})).statusCode,
					`${method} ${url} student`,
				).toBe(403);
				expect(
					(await bob(method, url, {})).statusCode,
					`${method} ${url} instructor`,
				).toBe(403);
			}
			// Refused callers changed and called nothing.
			expect(model.settings).toEqual([]);
			expect(await auditRows("ai_settings.updated")).toEqual([]);
		} finally {
			await app.close();
		}
	});
});

describe.skipIf(skip)("GET /admin/ai", () => {
	test("a fresh site: off, no key, the default limits", async () => {
		await withApp(async (call) => {
			const res = await call("GET", "/admin/ai");
			expect(res.statusCode).toBe(200);
			expect(AiSettingsView.parse(res.json())).toEqual({
				enabled: false,
				providerKind: "openai-compatible",
				baseUrl: null,
				model: null,
				keySet: false,
				keyHint: null,
				monthlyTokenCap: 5_000_000,
				conversationTokenBudget: 200_000,
				noticeVersion: null,
				noticeAcceptedAt: null,
				noticeAcceptedBy: null,
				usedThisMonth: 0,
				priceSources: [],
				triageEnabled: false,
				triageDailyLimit: 5,
				triageForward: false,
				hostListed: false,
			});
		});
	});

	test("shows this month's tokens and whether the base address host is on the proxy list", async () => {
		await writeFile(
			operatorFile,
			JSON.stringify({
				version: 1,
				hosts: ["api.openai.com", "other.example.com:8443"],
			}),
		);
		await testDb.db.updateTable("ai_settings").set({ base_url: BASE }).execute();
		await testDb.db
			.insertInto("ai_usage_days")
			.values({
				day: new Date().toISOString().slice(0, 10),
				purpose: "pricing",
				model: "m",
				input_tokens: 700,
				output_tokens: 50,
			})
			.execute();
		await withApp(async (call) => {
			const view = AiSettingsView.parse((await call("GET", "/admin/ai")).json());
			expect(view.usedThisMonth).toBe(750);
			expect(view.hostListed).toBe(true);
			await testDb.db
				.updateTable("ai_settings")
				.set({ base_url: "https://other.example.com/v1" })
				.execute();
			// Listed for another port only, so not reachable on 443.
			expect(
				AiSettingsView.parse((await call("GET", "/admin/ai")).json()).hostListed,
			).toBe(false);
		});
	});
});

describe.skipIf(skip)("PUT /admin/ai", () => {
	test("saves the settings, seals the key, shows only its last four characters", async () => {
		await withApp(async (call) => {
			const res = await call("PUT", "/admin/ai", {
				...FULL,
				monthlyTokenCap: 1_000_000,
				conversationTokenBudget: 50_000,
				priceSources: ["https://openai.com/api/pricing"],
			});
			expect(res.statusCode).toBe(200);
			const view = AiSettingsView.parse(res.json());
			expect(view).toMatchObject({
				enabled: false,
				providerKind: "openai-compatible",
				baseUrl: BASE,
				model: "gpt-x",
				keySet: true,
				keyHint: KEY.slice(-4),
				monthlyTokenCap: 1_000_000,
				conversationTokenBudget: 50_000,
				priceSources: ["https://openai.com/api/pricing"],
			});
			expect(res.body).not.toContain(KEY);
			const row = await testDb.db
				.selectFrom("ai_settings")
				.selectAll()
				.executeTakeFirstOrThrow();
			expect(row.key_sealed).toMatch(/^v1:/);
			expect(row.key_sealed).not.toContain(KEY);
			expect(row.key_hint).toBe(KEY.slice(-4));
		});
	});

	test("fields left out stay as they are", async () => {
		await withApp(async (call) => {
			await call("PUT", "/admin/ai", FULL);
			const res = await call("PUT", "/admin/ai", { model: "gpt-y" });
			expect(AiSettingsView.parse(res.json())).toMatchObject({
				baseUrl: BASE,
				model: "gpt-y",
				keySet: true,
				keyHint: KEY.slice(-4),
			});
		});
	});

	test("audits which fields changed, never the key's value", async () => {
		await withApp(async (call) => {
			await call("PUT", "/admin/ai", FULL);
			await call("PUT", "/admin/ai", { clearKey: true });
			// Nothing changed this time, so no row.
			await call("PUT", "/admin/ai", { model: "gpt-x" });
			const rows = await auditRows("ai_settings.updated");
			expect(rows).toHaveLength(2);
			expect(rows[0]).toMatchObject({ result: "ok", target: "ai_settings" });
			expect(rows[0]?.actor).toMatch(/^user:/);
			expect(rows[0]?.metadata).toEqual({
				changed: ["providerKind", "baseUrl", "model", "key"],
				key: "set",
			});
			expect(rows[1]?.metadata).toEqual({ changed: ["key"], key: "cleared" });
			expect(JSON.stringify(rows)).not.toContain(KEY);
		});
	});

	test("clearing the key removes it and switches the feature off", async () => {
		await withApp(async (call) => {
			await call("POST", "/admin/ai/notice", { noticeVersion: AI_NOTICE_VERSION });
			await call("PUT", "/admin/ai", { ...FULL, enabled: true });
			const res = await call("PUT", "/admin/ai", { clearKey: true });
			expect(AiSettingsView.parse(res.json())).toMatchObject({
				enabled: false,
				keySet: false,
				keyHint: null,
			});
			const row = await testDb.db
				.selectFrom("ai_settings")
				.selectAll()
				.executeTakeFirstOrThrow();
			expect(row.key_sealed).toBeNull();
			expect((await auditRows("ai_settings.updated")).at(-1)?.metadata).toEqual({
				changed: ["key", "enabled"],
				key: "cleared",
			});
		});
	});

	test("turning on is refused with no key (409) and with no accepted notice (409)", async () => {
		await withApp(async (call) => {
			const noKey = await call("PUT", "/admin/ai", { enabled: true });
			expect(noKey.statusCode).toBe(409);
			expect(noKey.json()).toMatchObject({ code: "AI_KEY_REQUIRED" });
			const noNotice = await call("PUT", "/admin/ai", { ...FULL, enabled: true });
			expect(noNotice.statusCode).toBe(409);
			expect(noNotice.json()).toMatchObject({ code: "AI_NOTICE_REQUIRED" });
			// A refused save changed nothing, not even the key.
			expect(
				AiSettingsView.parse((await call("GET", "/admin/ai")).json()),
			).toMatchObject({
				enabled: false,
				keySet: false,
				baseUrl: null,
			});
			expect(await auditRows("ai_settings.updated")).toEqual([]);
		});
	});

	test("clearing the key in the same request does not satisfy the key check", async () => {
		await withApp(async (call) => {
			await call("POST", "/admin/ai/notice", { noticeVersion: AI_NOTICE_VERSION });
			await call("PUT", "/admin/ai", FULL);
			const res = await call("PUT", "/admin/ai", { enabled: true, clearKey: true });
			expect(res.statusCode).toBe(409);
			expect(res.json()).toMatchObject({ code: "AI_KEY_REQUIRED" });
		});
	});

	test("a notice accepted at an older version does not count", async () => {
		await testDb.db
			.updateTable("ai_settings")
			.set({ notice_version: AI_NOTICE_VERSION - 1 })
			.execute();
		await withApp(async (call) => {
			const res = await call("PUT", "/admin/ai", { ...FULL, enabled: true });
			expect(res.statusCode).toBe(409);
			expect(res.json()).toMatchObject({ code: "AI_NOTICE_REQUIRED" });
		});
	});

	test("turns on once there is a key and the notice is accepted, and off again", async () => {
		await withApp(async (call) => {
			await call("POST", "/admin/ai/notice", { noticeVersion: AI_NOTICE_VERSION });
			const on = await call("PUT", "/admin/ai", { ...FULL, enabled: true });
			expect(on.statusCode).toBe(200);
			expect(AiSettingsView.parse(on.json()).enabled).toBe(true);
			const off = await call("PUT", "/admin/ai", { enabled: false });
			expect(AiSettingsView.parse(off.json()).enabled).toBe(false);
		});
	});

	test("turning on with no base address or model is refused (409 AI_SETTINGS_INCOMPLETE)", async () => {
		await withApp(async (call) => {
			await call("POST", "/admin/ai/notice", { noticeVersion: AI_NOTICE_VERSION });
			const res = await call("PUT", "/admin/ai", { key: KEY, enabled: true });
			expect(res.statusCode).toBe(409);
			expect(res.json()).toMatchObject({ code: "AI_SETTINGS_INCOMPLETE" });
			expect(
				AiSettingsView.parse((await call("GET", "/admin/ai")).json()),
			).toMatchObject({ enabled: false, keySet: false });
		});
	});

	test("a new provider or base address host needs the key entered again (409 AI_KEY_REQUIRED)", async () => {
		await withApp(async (call) => {
			await call("PUT", "/admin/ai", FULL);
			for (const body of [
				{ baseUrl: "https://models.elsewhere.example.com/v1" },
				{ providerKind: "anthropic" },
			]) {
				const res = await call("PUT", "/admin/ai", body);
				expect(res.statusCode, JSON.stringify(body)).toBe(409);
				expect(res.json()).toMatchObject({ code: "AI_KEY_REQUIRED" });
			}
			expect(
				AiSettingsView.parse((await call("GET", "/admin/ai")).json()),
			).toMatchObject({ baseUrl: BASE, providerKind: "openai-compatible" });
			const moved = await call("PUT", "/admin/ai", {
				baseUrl: "https://models.elsewhere.example.com/v1",
				key: "another-provider-key-1234",
			});
			expect(moved.statusCode).toBe(200);
		});
	});

	test("refuses a body the contract does not accept, without echoing the key", async () => {
		await withApp(async (call) => {
			const cases: unknown[] = [
				{ key: KEY, clearKey: true },
				{ baseUrl: "http://api.openai.com/v1", key: KEY },
				{ baseUrl: "https://10.0.0.5/v1", key: KEY },
				{ unknown: 1, key: KEY },
				{ monthlyTokenCap: 0 },
			];
			for (const body of cases) {
				const res = await call("PUT", "/admin/ai", body);
				expect(res.statusCode, JSON.stringify(body)).toBe(400);
				expect(res.body).not.toContain(KEY);
			}
		});
	});

	test("refuses an address on the site's own preview hosts, for the base and for a price source", async () => {
		await withApp(async (call) => {
			for (const body of [
				{ baseUrl: "https://tool-5173.preview.school.edu/v1" },
				{ baseUrl: "https://preview.school.edu/v1" },
				{ priceSources: ["https://tool-5173.preview.school.edu/prices"] },
			]) {
				const res = await call("PUT", "/admin/ai", body);
				expect(res.statusCode, JSON.stringify(body)).toBe(400);
				expect(res.json()).toMatchObject({ code: "VALIDATION_FAILED" });
			}
			expect(
				AiSettingsView.parse((await call("GET", "/admin/ai")).json()).baseUrl,
			).toBeNull();
		});
	});
});

describe.skipIf(skip)("the proxy host offered with the address", () => {
	test("addProxyHost writes the proxy host request and its own audit row, in the same request", async () => {
		await withApp(async (call) => {
			const res = await call("PUT", "/admin/ai", {
				...FULL,
				priceSources: [
					"https://openai.com/api/pricing",
					"https://api.openai.com/prices",
				],
				addProxyHost: true,
			});
			expect(res.statusCode).toBe(200);
			const [name, ...rest] = await requests();
			expect(rest).toEqual([]);
			const request = SiteJobRequest.parse(
				JSON.parse(await readFile(join(jobsDir, name ?? ""), "utf8")),
			);
			expect(request).toMatchObject({
				kind: "proxy-hosts",
				hosts: ["api.openai.com", "openai.com"],
			});
			const proxyRows = await auditRows("site.job_requested");
			expect(proxyRows).toHaveLength(1);
			expect(proxyRows[0]?.metadata).toMatchObject({ kind: "proxy-hosts" });
			// The AI change has its own row.
			expect(await auditRows("ai_settings.updated")).toHaveLength(1);
			expect(AiSettingsView.parse(res.json()).baseUrl).toBe(BASE);
		});
	});

	test("the page's own hosts are kept, and listed hosts are not added again", async () => {
		await writeFile(
			hostsFile,
			JSON.stringify({ version: 1, hosts: ["Keep.example.com"] }),
		);
		await writeFile(
			operatorFile,
			JSON.stringify({ version: 1, hosts: ["openai.com"] }),
		);
		await withApp(async (call) => {
			await call("PUT", "/admin/ai", {
				...FULL,
				priceSources: ["https://openai.com/api/pricing"],
				addProxyHost: true,
			});
			const [name] = await requests();
			const request = SiteJobRequest.parse(
				JSON.parse(await readFile(join(jobsDir, name ?? ""), "utf8")),
			);
			expect(request).toMatchObject({
				kind: "proxy-hosts",
				hosts: ["keep.example.com", "api.openai.com"],
			});
		});
	});

	test("nothing is written when every host is already listed", async () => {
		await writeFile(
			operatorFile,
			JSON.stringify({ version: 1, hosts: ["api.openai.com"] }),
		);
		await withApp(async (call) => {
			const res = await call("PUT", "/admin/ai", { ...FULL, addProxyHost: true });
			expect(res.statusCode).toBe(200);
			expect(AiSettingsView.parse(res.json()).hostListed).toBe(true);
			expect(await requests()).toEqual([]);
			expect(await auditRows("site.job_requested")).toEqual([]);
		});
	});

	test("without addProxyHost the settings save and no proxy request is written", async () => {
		await withApp(async (call) => {
			for (const body of [FULL, { ...FULL, addProxyHost: false }]) {
				expect((await call("PUT", "/admin/ai", body)).statusCode).toBe(200);
			}
			expect(await requests()).toEqual([]);
			expect(await auditRows("site.job_requested")).toEqual([]);
		});
	});

	test("a busy site job answers 409 and saves nothing", async () => {
		await withApp(async (call) => {
			expect(
				(await call("PUT", "/admin/proxy-hosts", { hosts: ["first.example.com"] }))
					.statusCode,
			).toBe(202);
			const res = await call("PUT", "/admin/ai", { ...FULL, addProxyHost: true });
			expect(res.statusCode).toBe(409);
			expect(res.json()).toMatchObject({ code: "SITE_JOB_BUSY" });
			expect(
				AiSettingsView.parse((await call("GET", "/admin/ai")).json()),
			).toMatchObject({
				keySet: false,
				baseUrl: null,
			});
			expect(await auditRows("ai_settings.updated")).toEqual([]);
		});
	});

	test("a full proxy list answers 400 and saves nothing", async () => {
		const hosts = Array.from(
			{ length: MAX_PROXY_HOSTS },
			(_, i) => `h${i}.example.org`,
		);
		await writeFile(hostsFile, JSON.stringify({ version: 1, hosts }));
		await withApp(async (call) => {
			const res = await call("PUT", "/admin/ai", { ...FULL, addProxyHost: true });
			expect(res.statusCode).toBe(400);
			expect(await requests()).toEqual([]);
			expect(AiSettingsView.parse((await call("GET", "/admin/ai")).json()).keySet).toBe(
				false,
			);
		});
	});

	test("on a server with no site job directory the settings still save", async () => {
		await withApp(
			async (call) => {
				const res = await call("PUT", "/admin/ai", { ...FULL, addProxyHost: true });
				expect(res.statusCode).toBe(200);
				expect(AiSettingsView.parse(res.json())).toMatchObject({
					keySet: true,
					hostListed: false,
				});
				expect(await requests()).toEqual([]);
			},
			{ SITE_JOBS_DIR: undefined },
		);
	});
});

describe.skipIf(skip)("POST /admin/ai/notice", () => {
	test("records the version, who accepted and when, and audits it", async () => {
		await withApp(async (call) => {
			const res = await call("POST", "/admin/ai/notice", {
				noticeVersion: AI_NOTICE_VERSION,
			});
			expect(res.statusCode).toBe(200);
			const view = AiSettingsView.parse(res.json());
			expect(view.noticeVersion).toBe(AI_NOTICE_VERSION);
			expect(view.noticeAcceptedBy).toBe("Carol Admin");
			expect(Date.now() - new Date(view.noticeAcceptedAt ?? 0).getTime()).toBeLessThan(
				60_000,
			);
			const rows = await auditRows("ai.notice_accepted");
			expect(rows).toHaveLength(1);
			expect(rows[0]?.metadata).toEqual({ noticeVersion: AI_NOTICE_VERSION });
			expect(rows[0]?.actor).toMatch(/^user:/);
		});
	});

	test("refuses a version that is not the current notice", async () => {
		await withApp(async (call) => {
			for (const noticeVersion of [AI_NOTICE_VERSION + 1, 99]) {
				const res = await call("POST", "/admin/ai/notice", { noticeVersion });
				expect(res.statusCode).toBe(400);
			}
			expect((await call("POST", "/admin/ai/notice", {})).statusCode).toBe(400);
			expect(await auditRows("ai.notice_accepted")).toEqual([]);
		});
	});
});

describe.skipIf(skip)("POST /admin/ai/test", () => {
	async function saved(call: Call): Promise<void> {
		expect((await call("PUT", "/admin/ai", FULL)).statusCode).toBe(200);
	}

	function useModel(steps: FakeStep[]) {
		const fake = createFakeModelClient(steps);
		model.client = fake;
		return fake;
	}

	test("reports not configured, and calls no model, until a key and model are saved", async () => {
		useModel([]);
		await withApp(async (call) => {
			const res = await call("POST", "/admin/ai/test");
			expect(TestAiResult.parse(res.json())).toEqual({
				ok: false,
				stage: null,
				errorCode: "not-configured",
				model: null,
				usage: null,
			});
			expect(model.settings).toEqual([]);
		});
	});

	test("a full round trip: a real tool call, its result, and a final reply", async () => {
		const fake = useModel([
			[PING, FINISH(100, 20)],
			[{ type: "text", text: "pong" }, FINISH(150, 5)],
		]);
		await withApp(async (call) => {
			await saved(call);
			const res = await call("POST", "/admin/ai/test");
			expect(TestAiResult.parse(res.json())).toEqual({
				ok: true,
				stage: "tool-result",
				errorCode: null,
				model: "gpt-x",
				usage: { inputTokens: 250, outputTokens: 25 },
			});
			// The saved key, address and model were passed on explicitly.
			expect(model.settings).toEqual([
				{ kind: "openai-compatible", baseUrl: BASE, apiKey: KEY, model: "gpt-x" },
			]);
			// Step one offers the one tool; step two carries its result back.
			const [first, second] = fake.requests;
			expect(first?.tools.map((t) => t.name)).toEqual(["portikus_ping"]);
			expect(first?.system).toContain("portikus_ping");
			expect(first?.messages).toHaveLength(1);
			expect(second?.messages.map((m) => m.role)).toEqual([
				"user",
				"assistant",
				"tool",
			]);
			expect(second?.messages[2]).toEqual({
				role: "tool",
				results: [{ id: "call-1", name: "portikus_ping", text: "pong" }],
			});
			// No Portikus data goes to the model.
			expect(JSON.stringify(fake.requests)).not.toMatch(/carol|example\.edu|@/i);
		});
	});

	test("counts its tokens under the administrator, as assistant use", async () => {
		useModel([
			[PING, FINISH(100, 20)],
			[{ type: "text", text: "pong" }, FINISH(150, 5)],
		]);
		await withApp(async (call) => {
			await saved(call);
			await call("POST", "/admin/ai/test");
			const admin = await testDb.db
				.selectFrom("users")
				.select("id")
				.where("oidc_subject", "=", "carol")
				.executeTakeFirstOrThrow();
			const rows = await testDb.db.selectFrom("ai_usage_days").selectAll().execute();
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({
				user_id: admin.id,
				purpose: "assistant",
				model: "gpt-x",
				input_tokens: "250",
				output_tokens: "25",
			});
			expect(
				AiSettingsView.parse((await call("GET", "/admin/ai")).json()).usedThisMonth,
			).toBe(275);
		});
	});

	test.each([
		"auth",
		"rate-limited",
		"unreachable",
		"bad-response",
		"aborted",
		"other",
	] as const)(
		"%s before anything arrives: no stage reached, the code reported",
		async (code) => {
			useModel([{ error: code }]);
			await withApp(async (call) => {
				await saved(call);
				const res = TestAiResult.parse((await call("POST", "/admin/ai/test")).json());
				expect(res).toMatchObject({
					ok: false,
					stage: null,
					errorCode: code,
					usage: null,
				});
				expect(
					await testDb.db.selectFrom("ai_usage_days").selectAll().execute(),
				).toEqual([]);
			});
		},
	);

	test("an error after the server started answering: connect was reached", async () => {
		model.client = {
			step: async function* () {
				yield { type: "text", text: "hi" } satisfies ModelPart;
				const { ModelError } = await import("../ai/model.js");
				throw new ModelError("bad-response");
			},
			listModels: async () => null,
		} satisfies ModelClient;
		await withApp(async (call) => {
			await saved(call);
			expect(
				TestAiResult.parse((await call("POST", "/admin/ai/test")).json()),
			).toMatchObject({
				ok: false,
				stage: "connect",
				errorCode: "bad-response",
			});
		});
	});

	test("a stream that ends with no finish: connect, bad-response", async () => {
		useModel([[{ type: "text", text: "hi" }]]);
		await withApp(async (call) => {
			await saved(call);
			expect(
				TestAiResult.parse((await call("POST", "/admin/ai/test")).json()),
			).toMatchObject({
				ok: false,
				stage: "connect",
				errorCode: "bad-response",
			});
		});
	});

	test("a reply with no tool call: reply reached, no-tool-call", async () => {
		useModel([[{ type: "text", text: "pong" }, FINISH()]]);
		await withApp(async (call) => {
			await saved(call);
			expect(
				TestAiResult.parse((await call("POST", "/admin/ai/test")).json()),
			).toMatchObject({
				ok: false,
				stage: "reply",
				errorCode: "no-tool-call",
				usage: { inputTokens: 10, outputTokens: 5 },
			});
		});
	});

	test("a call to the wrong tool or with no word: reply reached, bad-tool-call", async () => {
		for (const call of [
			{ ...PING, name: "other_tool" },
			{ ...PING, input: {} },
			{ ...PING, input: "pong" },
		]) {
			useModel([[call, FINISH()]]);
			await withApp(async (send) => {
				await saved(send);
				expect(
					TestAiResult.parse((await send("POST", "/admin/ai/test")).json()),
				).toMatchObject({
					ok: false,
					stage: "reply",
					errorCode: "bad-tool-call",
				});
			});
		}
	});

	test("an error after the tool result was sent: tool-call reached", async () => {
		useModel([[PING, FINISH()], { error: "rate-limited" }]);
		await withApp(async (call) => {
			await saved(call);
			expect(
				TestAiResult.parse((await call("POST", "/admin/ai/test")).json()),
			).toMatchObject({
				ok: false,
				stage: "tool-call",
				errorCode: "rate-limited",
			});
		});
	});

	test("an empty final reply: tool-call reached, empty-reply", async () => {
		useModel([
			[PING, FINISH()],
			[{ type: "text", text: "  " }, FINISH()],
		]);
		await withApp(async (call) => {
			await saved(call);
			expect(
				TestAiResult.parse((await call("POST", "/admin/ai/test")).json()),
			).toMatchObject({
				ok: false,
				stage: "tool-call",
				errorCode: "empty-reply",
			});
		});
	});

	test("a refused host change adds no proxy host, and the test still uses the saved address", async () => {
		useModel([
			[PING, FINISH(10, 2)],
			[{ type: "text", text: "pong" }, FINISH(10, 2)],
		]);
		await withApp(async (call) => {
			await saved(call);
			const res = await call("PUT", "/admin/ai", {
				baseUrl: "https://models.elsewhere.example.com/v1",
				addProxyHost: true,
			});
			expect(res.statusCode).toBe(409);
			expect(await requests()).toEqual([]);
			const test = await call("POST", "/admin/ai/test");
			expect(TestAiResult.parse(test.json()).ok).toBe(true);
			expect(model.settings.map((s) => s.baseUrl)).toEqual([BASE]);
		});
	});

	test("works while the feature is off and before the notice is accepted", async () => {
		useModel([
			[PING, FINISH()],
			[{ type: "text", text: "pong" }, FINISH()],
		]);
		await withApp(async (call) => {
			await saved(call);
			expect(
				AiSettingsView.parse((await call("GET", "/admin/ai")).json()).enabled,
			).toBe(false);
			expect(TestAiResult.parse((await call("POST", "/admin/ai/test")).json()).ok).toBe(
				true,
			);
		});
	});
});

describe.skipIf(skip)("GET /admin/ai/models", () => {
	test("lists the server's models, or null with none saved or when the server has no list", async () => {
		await withApp(async (call) => {
			model.client = createFakeModelClient([], ["gpt-x", "gpt-y"]);
			expect((await call("GET", "/admin/ai/models")).json()).toEqual({ models: null });
			expect(model.settings).toEqual([]);
			await call("PUT", "/admin/ai", FULL);
			const res = await call("GET", "/admin/ai/models");
			expect(ModelListResponse.parse(res.json())).toEqual({
				models: ["gpt-x", "gpt-y"],
			});
			expect(model.settings[0]).toMatchObject({ apiKey: KEY, baseUrl: BASE });
			model.client = createFakeModelClient([], null);
			expect((await call("GET", "/admin/ai/models")).json()).toEqual({ models: null });
		});
	});
});

describe.skipIf(skip)("the key stays secret", () => {
	test("it is in no answer, audit row or log line, through a whole session of use", async () => {
		model.client = createFakeModelClient(
			[[PING, FINISH()], [{ type: "text", text: "pong" }, FINISH()], { error: "auth" }],
			["gpt-x"],
		);
		const bodies: string[] = [];
		await withApp(async (call) => {
			for (const [method, url, payload] of [
				["PUT", "/admin/ai", { ...FULL, addProxyHost: true }],
				["POST", "/admin/ai/notice", { noticeVersion: AI_NOTICE_VERSION }],
				["PUT", "/admin/ai", { enabled: true }],
				["GET", "/admin/ai", undefined],
				["POST", "/admin/ai/test", undefined],
				["POST", "/admin/ai/test", undefined],
				["GET", "/admin/ai/models", undefined],
				["PUT", "/admin/ai", { key: "x".repeat(2000) }],
				["PUT", "/admin/ai", { clearKey: true }],
			] as const) {
				bodies.push((await call(method, url, payload)).body);
			}
		});
		const audit = await testDb.db
			.selectFrom("audit_events")
			.select("metadata")
			.execute();
		const everything = [...bodies, JSON.stringify(audit), ...logLines].join("\n");
		expect(everything).not.toContain(KEY);
		expect(everything).not.toContain(KEY.slice(0, 12));
		expect(logLines.length).toBeGreaterThan(0);
	});
});
