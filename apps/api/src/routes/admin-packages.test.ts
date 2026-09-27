import {
	CookieJar,
	loginAs,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import { ADMIN_PACKAGES_LIMIT } from "@portikus/contracts";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { buildTestServer, PUBLIC_URL } from "../test-support.js";

/** The package survey's admin table (SPEC.md §20.1, ADR 0042). */

const skip = !hasTestDb();

let testDb: TestDb;
let mock: MockOidcProvider;
let app: FastifyInstance;
let alice: CookieJar;
let carol: CookieJar;

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
	app = buildTestServer(testDb.db, mock.issuer);
	alice = new CookieJar();
	await loginAs(app, "alice", alice);
	carol = new CookieJar();
	await loginAs(app, "carol", carol);
	return async () => {
		await app.close();
	};
});

function get(jar: CookieJar) {
	return app.inject({
		method: "GET",
		url: "/admin/packages",
		headers: { cookie: jar.cookieHeader() },
	});
}

async function seedDay(day: string, surveyed: number, counts: Record<string, number>) {
	await testDb.db.insertInto("package_survey_days").values({ day, surveyed }).execute();
	const rows = Object.entries(counts).map(([name, workspaces]) => ({
		day,
		package: name,
		workspaces,
	}));
	if (rows.length > 0)
		await testDb.db.insertInto("package_survey_counts").values(rows).execute();
}

test.skipIf(skip)("students are refused", async () => {
	expect((await get(alice)).statusCode).toBe(403);
});

test.skipIf(skip)("before any survey the table is empty", async () => {
	const response = await get(carol);
	expect(response.statusCode).toBe(200);
	expect(response.json()).toEqual({ day: null, surveyed: 0, packages: [] });
});

test.skipIf(skip)(
	"shows the latest day's counts with first and last seen",
	async () => {
		await seedDay("2026-09-23", 8, { "python3-venv": 4, cowsay: 1 });
		await seedDay("2026-09-26", 9, { "python3-venv": 6, htop: 2, gh: 1 });

		const body = (await get(carol)).json();

		expect(body.day).toBe("2026-09-26");
		expect(body.surveyed).toBe(9);
		expect(body.packages).toEqual([
			{
				package: "python3-venv",
				workspaces: 6,
				firstSeen: "2026-09-23",
				lastSeen: "2026-09-26",
				candidate: true,
			},
			{
				package: "htop",
				workspaces: 2,
				firstSeen: "2026-09-26",
				lastSeen: "2026-09-26",
				candidate: false,
			},
			{
				package: "gh",
				workspaces: 1,
				firstSeen: "2026-09-26",
				lastSeen: "2026-09-26",
				candidate: false,
			},
			{
				package: "cowsay",
				workspaces: 0,
				firstSeen: "2026-09-23",
				lastSeen: "2026-09-23",
				candidate: false,
			},
		]);
	},
);

test.skipIf(skip)("returns at most the limit, most-added first", async () => {
	const counts: Record<string, number> = {};
	for (let i = 0; i < ADMIN_PACKAGES_LIMIT + 5; i++) counts[`pkg${i}`] = 1;
	counts.zz = 3;
	await seedDay("2026-09-26", 3, counts);
	const body = (await get(carol)).json();
	expect(body.packages).toHaveLength(ADMIN_PACKAGES_LIMIT);
	expect(body.packages[0].package).toBe("zz");
});

test.skipIf(skip)(
	"a day with fewer than 3 surveyed workspaces is never shown, so no one student shows",
	async () => {
		await seedDay("2026-09-23", 4, { "python3-venv": 2 });
		await seedDay("2026-09-26", 1, { cowsay: 1, "python3-venv": 1 });

		const body = (await get(carol)).json();

		expect(body.day).toBe("2026-09-23");
		expect(body.surveyed).toBe(4);
		expect(body.packages).toEqual([
			{
				package: "python3-venv",
				workspaces: 2,
				firstSeen: "2026-09-23",
				lastSeen: "2026-09-23",
				candidate: true,
			},
		]);
	},
);

test.skipIf(skip)(
	"with no day of 3 surveyed, no rows and the latest day's count say why",
	async () => {
		await seedDay("2026-09-24", 2, { htop: 2 });
		await seedDay("2026-09-26", 1, { cowsay: 1 });

		expect((await get(carol)).json()).toEqual({
			day: "2026-09-26",
			surveyed: 1,
			packages: [],
		});
	},
);

test.skipIf(skip)(
	"today is never shown, so watching its count grow cannot single out a workspace",
	async () => {
		const today = new Date().toISOString().slice(0, 10);
		await seedDay("2026-09-23", 5, { htop: 2 });
		await seedDay(today, 9, { htop: 3, cowsay: 1 });

		const body = (await get(carol)).json();

		expect(body.day).toBe("2026-09-23");
		expect(body.surveyed).toBe(5);
		expect(body.packages).toEqual([
			{
				package: "htop",
				workspaces: 2,
				firstSeen: "2026-09-23",
				lastSeen: "2026-09-23",
				candidate: true,
			},
		]);
	},
);

test.skipIf(skip)("with only today surveyed, nothing is shown yet", async () => {
	await seedDay(new Date().toISOString().slice(0, 10), 9, { htop: 3 });
	expect((await get(carol)).json()).toEqual({ day: null, surveyed: 0, packages: [] });
});
