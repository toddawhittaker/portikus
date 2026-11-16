/**
 * The price table routes (SPEC.md sections 10.8, 20.4, 24): administrators
 * only, session only, each change audited without page text; the table
 * itself readable by any signed-in user.
 */
import {
	CookieJar,
	csrfHeaders,
	loginAs,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import { AI_NOTICE_VERSION, PriceRun, PricingTable } from "@portikus/contracts";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { createFakeModelClient } from "../ai/fake-model.js";
import type { SourcePage } from "../pricing/fetch.js";
import { buildTestServer, PUBLIC_URL } from "../testing/test-support.js";

const state = vi.hoisted(() => ({ client: null as unknown, page: null as unknown }));

vi.mock("../ai/model.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../ai/model.js")>()),
	createModelClient: () => state.client,
}));
vi.mock("../pricing/fetch.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../pricing/fetch.js")>()),
	fetchSource: async () => state.page as SourcePage,
}));

const skip = !hasTestDb();
let testDb: TestDb;
let mock: MockOidcProvider;
const SOURCE = "https://openai.com/api/pricing";
const QUOTE = "Model A input $2.00 per million";

const ROW = {
	provider: "openai",
	model: "model-a",
	inputPricePerMillion: 2,
	cacheReadRatio: 0.1,
	cacheWriteRatio: 1.25,
	cacheWriteOneHourRatio: null,
	cacheTtlSeconds: 300,
	surchargeAboveTokens: null,
	surchargeFactor: null,
	sourceUrl: SOURCE,
	sourceQuote: QUOTE,
};

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
	for (const t of [
		"price_proposals",
		"price_runs",
		"model_prices",
		"ai_usage_days",
	] as const)
		await testDb.db.deleteFrom(t).execute();
	await testDb.db
		.updateTable("ai_settings")
		.set({
			enabled: false,
			provider_kind: null,
			base_url: null,
			model: null,
			key_hint: null,
			notice_accepted_by: null,
			notice_accepted_at: null,
			key_sealed: null,
			notice_version: null,
			price_sources: [SOURCE],
		})
		.execute();
	state.page = { ok: true, html: `<p>${QUOTE}</p>` };
	state.client = createFakeModelClient([
		[
			{ type: "tool-call", id: "c1", name: "submit_rows", input: { rows: [ROW] } },
			{
				type: "finish",
				reason: "tool-calls",
				usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0 },
			},
		],
	]);
});

type Call = (
	method: "GET" | "PUT" | "POST" | "DELETE",
	url: string,
	payload?: unknown,
) => Promise<{ statusCode: number; json: () => unknown }>;

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

async function withApp(run: (admin: Call, app: FastifyInstance) => Promise<void>) {
	const app = buildTestServer(testDb.db, mock.issuer);
	await app.ready();
	try {
		await run(await as(app, "carol"), app);
	} finally {
		await app.close();
	}
}

async function switchOn(admin: Call) {
	await admin("PUT", "/admin/ai", {
		providerKind: "openai-compatible",
		baseUrl: "https://api.openai.com/v1",
		model: "gpt-x",
		key: "fake-provider-key-for-tests-WXYZ",
	});
	await admin("POST", "/admin/ai/notice", { noticeVersion: AI_NOTICE_VERSION });
	const on = await admin("PUT", "/admin/ai", { enabled: true });
	expect(on.statusCode).toBe(200);
}

async function waitForRun(): Promise<void> {
	for (let i = 0; i < 100; i++) {
		const r = await testDb.db
			.selectFrom("price_runs")
			.select("status")
			.executeTakeFirst();
		if (r && r.status !== "running") return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("the run did not finish");
}

async function audit(action: string) {
	return testDb.db
		.selectFrom("audit_events")
		.selectAll()
		.where("action", "=", action)
		.orderBy("at")
		.execute();
}

describe.skipIf(skip)("who may use the price routes", () => {
	test("students and instructors get 403 on every admin route; anyone signed in reads /pricing", async () => {
		await withApp(async (_admin, app) => {
			const alice = await as(app, "alice");
			const bob = await as(app, "bob");
			await testDb.db
				.updateTable("users")
				.set({ granted_role: "instructor", role: "instructor" })
				.where("oidc_subject", "=", "bob")
				.execute();
			const id = crypto.randomUUID();
			const routes = [
				["GET", "/admin/pricing"],
				["POST", "/admin/pricing/refresh"],
				["POST", `/admin/pricing/proposals/${id}/decision`],
				["POST", "/admin/pricing/rows"],
				["PUT", `/admin/pricing/rows/${id}`],
				["DELETE", `/admin/pricing/rows/${id}`],
			] as const;
			for (const [method, url] of routes) {
				expect(
					(await alice(method, url, {})).statusCode,
					`${method} ${url} student`,
				).toBe(403);
				expect(
					(await bob(method, url, {})).statusCode,
					`${method} ${url} instructor`,
				).toBe(403);
			}
			const table = await alice("GET", "/pricing");
			expect(table.statusCode).toBe(200);
			expect(PricingTable.parse(table.json())).toEqual({ prices: [] });
			const none = await app.inject({ method: "GET", url: "/pricing" });
			expect(none.statusCode).toBe(401);
		});
	});
});

describe.skipIf(skip)("a price check from the page", () => {
	test("refresh is refused while the AI is unavailable", async () => {
		await withApp(async (admin) => {
			const res = await admin("POST", "/admin/pricing/refresh");
			expect(res.statusCode).toBe(409);
			expect(res.json()).toMatchObject({ code: "AGENT_UNAVAILABLE" });
		});
	});

	test("refresh starts a run (202), a second while it runs is 409, and accept stores the row", async () => {
		await withApp(async (admin) => {
			await switchOn(admin);
			await testDb.db.insertInto("price_runs").values({ trigger: "manual" }).execute();
			const busy = await admin("POST", "/admin/pricing/refresh");
			expect(busy.statusCode).toBe(409);
			expect(busy.json()).toMatchObject({ code: "OPERATION_IN_PROGRESS" });
			await testDb.db.deleteFrom("price_runs").execute();

			const res = await admin("POST", "/admin/pricing/refresh");
			expect(res.statusCode).toBe(202);
			expect(PriceRun.parse(res.json()).status).toBe("running");
			await waitForRun();
			expect(await audit("pricing.refresh_started")).toHaveLength(1);

			const view = (await admin("GET", "/admin/pricing")).json() as {
				run: { status: string; proposalCount: number };
				proposals: { id: string; current: unknown; model: string }[];
			};
			expect(view.run).toMatchObject({ status: "done", proposalCount: 1 });
			expect(view.proposals).toMatchObject([{ model: "model-a", current: null }]);

			const id = view.proposals[0]?.id;
			const bad = await admin("POST", `/admin/pricing/proposals/${id}/decision`, {
				decision: "maybe",
			});
			expect(bad.statusCode).toBe(400);
			const ok = await admin("POST", `/admin/pricing/proposals/${id}/decision`, {
				decision: "accept",
			});
			expect(ok.statusCode).toBe(200);
			const again = await admin("POST", `/admin/pricing/proposals/${id}/decision`, {
				decision: "reject",
			});
			expect(again.statusCode).toBe(404);

			const prices = await testDb.db.selectFrom("model_prices").selectAll().execute();
			expect(prices).toHaveLength(1);
			expect(prices[0]?.updated_by).not.toBeNull();
			expect(await audit("pricing.proposal_decided")).toMatchObject([
				{ metadata: { decision: "accepted", provider: "openai", model: "model-a" } },
			]);
			const pub = PricingTable.parse((await admin("GET", "/pricing")).json());
			expect(pub.prices).toMatchObject([{ model: "model-a", inputPricePerMillion: 2 }]);
		});
	});

	test("a rejected proposal leaves the table alone", async () => {
		await withApp(async (admin) => {
			await switchOn(admin);
			await admin("POST", "/admin/pricing/refresh");
			await waitForRun();
			const [p] = await testDb.db.selectFrom("price_proposals").select("id").execute();
			const res = await admin("POST", `/admin/pricing/proposals/${p?.id}/decision`, {
				decision: "reject",
			});
			expect(res.statusCode).toBe(200);
			expect(
				await testDb.db.selectFrom("model_prices").selectAll().execute(),
			).toHaveLength(0);
			expect(await audit("pricing.proposal_decided")).toMatchObject([
				{ metadata: { decision: "rejected" } },
			]);
		});
	});
});

describe.skipIf(skip)("manual edits", () => {
	test("add, edit and delete are validated and audited", async () => {
		await withApp(async (admin) => {
			const invalid = await admin("POST", "/admin/pricing/rows", {
				...ROW,
				surchargeFactor: 2,
			});
			expect(invalid.statusCode).toBe(400);
			const added = await admin("POST", "/admin/pricing/rows", ROW);
			expect(added.statusCode).toBe(201);
			const dup = await admin("POST", "/admin/pricing/rows", ROW);
			expect(dup.statusCode).toBe(409);
			const { prices } = added.json() as { prices: { id: string }[] };
			const id = prices[0]?.id;

			const edited = await admin("PUT", `/admin/pricing/rows/${id}`, {
				...ROW,
				inputPricePerMillion: 3,
			});
			expect(edited.statusCode).toBe(200);
			expect(edited.json()).toMatchObject({ prices: [{ inputPricePerMillion: 3 }] });
			await admin("POST", "/admin/pricing/rows", { ...ROW, model: "model-b" });
			const clash = await admin("PUT", `/admin/pricing/rows/${id}`, {
				...ROW,
				model: "model-b",
			});
			expect(clash.statusCode).toBe(409);
			const missing = await admin(
				"PUT",
				`/admin/pricing/rows/${crypto.randomUUID()}`,
				ROW,
			);
			expect(missing.statusCode).toBe(404);

			expect((await admin("DELETE", `/admin/pricing/rows/${id}`)).statusCode).toBe(200);
			expect((await admin("DELETE", `/admin/pricing/rows/${id}`)).statusCode).toBe(404);

			const rows = await audit("pricing.row_changed");
			expect(rows.map((r) => (r.metadata as { change: string }).change)).toEqual([
				"added",
				"edited",
				"added",
				"deleted",
			]);
			expect(JSON.stringify(rows)).not.toContain(QUOTE);
		});
	});
});
