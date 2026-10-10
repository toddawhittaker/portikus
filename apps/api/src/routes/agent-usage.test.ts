import { randomUUID } from "node:crypto";
import { createSession } from "@portikus/auth";
import { AgentUsageResponse } from "@portikus/contracts";
import {
	createTestDb,
	hasTestDb,
	insertTestLtiMembership,
	insertTestLtiUser,
	insertTestUser,
	type TestDb,
} from "@portikus/db/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { buildTestServer } from "../testing/test-support.js";

/** Coding-agent usage views (SPEC.md §25.10, ADR 0057). */

const skip = !hasTestDb();
let testDb: TestDb;
let app: FastifyInstance;

beforeAll(async () => {
	if (skip) return;
	testDb = await createTestDb();
});

afterAll(async () => {
	if (skip) return;
	await testDb.close();
});

beforeEach(async () => {
	if (skip) return;
	await testDb.truncate();
	app = buildTestServer(testDb.db, "http://127.0.0.1:1/unused");
	await app.ready();
	return () => app.close();
});

async function cookieFor(userId: string): Promise<string> {
	const session = await createSession(testDb.db, userId, 3600, {
		method: "oidc",
		courseUserId: null,
	});
	return `portikus_session=${session.token}`;
}

async function get(url: string, userId: string) {
	return app.inject({ url, headers: { cookie: await cookieFor(userId) } });
}

function dayOffset(daysAgo: number): string {
	return new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
}

async function addUsage(
	userId: string,
	daysAgo: number,
	values: {
		bootId?: string;
		model?: string;
		agent?: "claude" | "codex";
		input?: number;
		cost?: number | null;
	} = {},
) {
	await testDb.db
		.insertInto("agent_usage_days")
		.values({
			user_id: userId,
			boot_id: values.bootId ?? randomUUID(),
			day: dayOffset(daysAgo),
			agent: values.agent ?? "claude",
			model: values.model ?? "opus",
			sessions: 1,
			input_tokens: values.input ?? 10,
			output_tokens: 5,
			cost_usd: values.cost === undefined ? null : values.cost,
			lines_added: 3,
			lines_removed: 1,
		})
		.execute();
}

/** Ivy teaches CS 101 with Sam; Zed is in no course; Ned is Ivy's student in CS 240 only. */
async function seed() {
	const ivy = await insertTestLtiUser(testDb.db, undefined, {
		display_name: "Ivy",
		role: "instructor",
	});
	const sam = await insertTestLtiUser(testDb.db, undefined, { display_name: "Sam" });
	const ned = await insertTestLtiUser(testDb.db, undefined, { display_name: "Ned" });
	const zed = await insertTestUser(testDb.db, { display_name: "Zed" });
	const admin = await insertTestUser(testDb.db, { role: "administrator" });
	const cs101 = await insertTestLtiMembership(testDb.db, ivy, {
		contextId: "cs101",
		role: "instructor",
	});
	await insertTestLtiMembership(testDb.db, sam, { contextId: "cs101" });
	const cs240 = await insertTestLtiMembership(testDb.db, ned, {
		contextId: "cs240",
		role: "instructor",
	});
	return { ivy, sam, ned, zed, admin, cs101, cs240 };
}

test.skipIf(skip)("another course's instructor gets 404, a student too", async () => {
	const { ned, sam, cs101 } = await seed();
	expect((await get(`/courses/${cs101}/agent-usage`, ned)).statusCode).toBe(404);
	expect((await get(`/courses/${cs101}/agent-usage`, sam)).statusCode).toBe(404);
	expect((await get("/courses/not-a-uuid/agent-usage", ned)).statusCode).toBe(404);
});

test.skipIf(skip)("the admin route refuses students and instructors", async () => {
	const { ivy, sam, admin } = await seed();
	expect((await get("/admin/agent-usage", sam)).statusCode).toBe(403);
	expect((await get("/admin/agent-usage", ivy)).statusCode).toBe(403);
	expect((await get("/admin/agent-usage", admin)).statusCode).toBe(200);
});

test.skipIf(skip)(
	"sums boot ids and models; the course view covers members only",
	async () => {
		const { ivy, sam, zed, cs101 } = await seed();
		await addUsage(sam, 0, { model: "opus", input: 10, cost: 0.5 });
		await addUsage(sam, 0, { model: "sonnet", input: 20, cost: 0.25 });
		await addUsage(sam, 1, { model: "opus", input: 100, cost: 1 });
		await addUsage(zed, 0, { input: 1000 });

		const res = await get(`/courses/${cs101}/agent-usage`, ivy);
		expect(res.statusCode).toBe(200);
		const body = AgentUsageResponse.parse(res.json());
		expect(body.days).toBe(7);
		expect(body.users).toHaveLength(1);
		expect(body.users[0]).toMatchObject({
			userId: sam,
			displayName: "Sam",
			agent: "claude",
			sessions: 3,
			inputTokens: 130,
			outputTokens: 15,
			costUsd: 1.75,
			linesAdded: 9,
			linesRemoved: 3,
		});
		expect(body.daily.map((d) => [d.day, d.inputTokens])).toEqual([
			[dayOffset(1), 100],
			[dayOffset(0), 30],
		]);
	},
);

test.skipIf(skip)(
	"the admin view covers everyone, with a null cost kept null",
	async () => {
		const { sam, zed, admin } = await seed();
		await addUsage(sam, 0, { agent: "codex", cost: null });
		await addUsage(zed, 0, { agent: "codex", cost: null });
		await addUsage(zed, 0, { agent: "claude", cost: 2 });

		const body = AgentUsageResponse.parse(
			(await get("/admin/agent-usage", admin)).json(),
		);
		expect(body.users.map((u) => [u.displayName, u.agent, u.costUsd])).toEqual([
			["Sam", "codex", null],
			["Zed", "claude", 2],
			["Zed", "codex", null],
		]);
		expect(body.daily.map((d) => [d.agent, d.costUsd])).toEqual([
			["claude", 2],
			["codex", null],
		]);
	},
);

test.skipIf(skip)(
	"the window includes its first day and excludes the day before",
	async () => {
		const { sam, admin } = await seed();
		await addUsage(sam, 6, { input: 1 });
		await addUsage(sam, 7, { input: 2 });
		await addUsage(sam, 29, { input: 4 });
		await addUsage(sam, 30, { input: 8 });

		const seven = AgentUsageResponse.parse(
			(await get("/admin/agent-usage", admin)).json(),
		);
		expect(seven.from).toBe(dayOffset(6));
		expect(seven.to).toBe(dayOffset(0));
		expect(seven.users[0]?.inputTokens).toBe(1);

		const thirty = AgentUsageResponse.parse(
			(await get("/admin/agent-usage?days=30", admin)).json(),
		);
		expect(thirty.days).toBe(30);
		expect(thirty.users[0]?.inputTokens).toBe(1 + 2 + 4);

		const ninety = AgentUsageResponse.parse(
			(await get("/admin/agent-usage?days=90", admin)).json(),
		);
		expect(ninety.users[0]?.inputTokens).toBe(15);
	},
);

test.skipIf(skip)("days other than 7, 30 or 90 is a 400", async () => {
	const { admin } = await seed();
	expect((await get("/admin/agent-usage?days=14", admin)).statusCode).toBe(400);
});
