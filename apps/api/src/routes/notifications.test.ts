import {
	CookieJar,
	csrfHeaders,
	loginAs,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import {
	MAX_NOTIFICATION_BODY_LENGTH,
	MAX_NOTIFICATION_TITLE_LENGTH,
	MAX_NOTIFICATIONS_PER_USER,
	NotificationList,
} from "@portikus/contracts";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import { collectingLogger } from "@portikus/observability/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { buildTestServer, PUBLIC_URL } from "../test-support.js";
import { NOTIFICATION_RECORDS_PER_MINUTE } from "./notifications.js";

// SPEC.md section 8.5 and ADR 0033: a user's own notification history.
const skip = !hasTestDb();
let testDb: TestDb;
let mock: MockOidcProvider;
let app: FastifyInstance;
let logs: Record<string, unknown>[];

beforeAll(async () => {
	if (skip) return;
	testDb = await createTestDb();
	mock = await startMockOidcProvider({
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
	const collected = collectingLogger("debug");
	logs = collected.lines;
	app = buildTestServer(testDb.db, mock.issuer, {}, collected.logger);
	await app.ready();
	return async () => {
		await app.close();
	};
});

async function signIn(name: string): Promise<CookieJar> {
	const jar = new CookieJar();
	await loginAs(app, name, jar);
	return jar;
}

function record(jar: CookieJar, payload: Record<string, unknown>) {
	return app.inject({
		method: "POST",
		url: "/me/notifications",
		headers: csrfHeaders(jar, PUBLIC_URL),
		payload,
	});
}

async function list(jar: CookieJar, query = ""): Promise<NotificationList> {
	const res = await app.inject({
		method: "GET",
		url: `/me/notifications${query}`,
		headers: { cookie: jar.cookieHeader() },
	});
	expect(res.statusCode).toBe(200);
	return NotificationList.parse(res.json());
}

describe.skipIf(skip)("notifications API", () => {
	test("signed out, every route is 401", async () => {
		const res = await app.inject({ method: "GET", url: "/me/notifications" });
		expect(res.statusCode).toBe(401);
	});

	test("records a notification and lists it newest first with the unread count", async () => {
		const jar = await signIn("alice");
		expect((await record(jar, { tone: "neutral", title: "First" })).statusCode).toBe(
			201,
		);
		const second = await record(jar, {
			tone: "danger",
			title: "Second",
			body: "It broke",
		});
		expect(second.statusCode).toBe(201);
		expect(second.json()).toMatchObject({
			tone: "danger",
			body: "It broke",
			readAt: null,
		});

		const out = await list(jar);
		expect(out.unreadCount).toBe(2);
		expect(out.notifications.map((n) => n.title)).toEqual(["Second", "First"]);
		expect(out.notifications[1]?.body).toBe("");
	});

	test("limit caps the list to the newest", async () => {
		const jar = await signIn("alice");
		for (const title of ["a", "b", "c"]) {
			await record(jar, { tone: "neutral", title });
		}
		const first = await list(jar, "?limit=2");
		expect(first.notifications.map((n) => n.title)).toEqual(["c", "b"]);
		expect(first.unreadCount).toBe(3);
	});

	test("marks one read, then all read", async () => {
		const jar = await signIn("alice");
		const one = (await record(jar, { tone: "neutral", title: "one" })).json();
		await record(jar, { tone: "warning", title: "two" });
		await record(jar, { tone: "success", title: "three" });

		const patched = await app.inject({
			method: "PATCH",
			url: `/me/notifications/${one.id}`,
			headers: csrfHeaders(jar, PUBLIC_URL),
			payload: { read: true },
		});
		expect(patched.statusCode).toBe(200);
		expect(patched.json().readAt).not.toBeNull();
		expect((await list(jar)).unreadCount).toBe(2);

		const all = await app.inject({
			method: "POST",
			url: "/me/notifications/read-all",
			headers: csrfHeaders(jar, PUBLIC_URL),
		});
		expect(all.statusCode).toBe(204);
		const after = await list(jar);
		expect(after.unreadCount).toBe(0);
		expect(after.notifications.every((n) => n.readAt !== null)).toBe(true);
	});

	test("clears the list", async () => {
		const jar = await signIn("alice");
		await record(jar, { tone: "neutral", title: "gone soon" });
		const res = await app.inject({
			method: "DELETE",
			url: "/me/notifications",
			headers: csrfHeaders(jar, PUBLIC_URL),
		});
		expect(res.statusCode).toBe(204);
		expect(await list(jar)).toEqual({ notifications: [], unreadCount: 0 });
	});

	test(`keeps only the newest ${MAX_NOTIFICATIONS_PER_USER} per user`, async () => {
		const jar = await signIn("alice");
		const user = await testDb.db
			.selectFrom("users")
			.select("id")
			.executeTakeFirstOrThrow();
		const start = Date.parse("2026-09-01T00:00:00Z");
		await testDb.db
			.insertInto("notifications")
			.values(
				Array.from({ length: MAX_NOTIFICATIONS_PER_USER }, (_, i) => ({
					user_id: user.id,
					tone: "neutral",
					title: `old ${i}`,
					body: "",
					created_at: new Date(start + i * 1000).toISOString(),
				})),
			)
			.execute();
		expect((await record(jar, { tone: "neutral", title: "newest" })).statusCode).toBe(
			201,
		);
		const rows = await testDb.db
			.selectFrom("notifications")
			.select("title")
			.where("user_id", "=", user.id)
			.execute();
		expect(rows).toHaveLength(MAX_NOTIFICATIONS_PER_USER);
		const titles = rows.map((r) => r.title);
		expect(titles).toContain("newest");
		expect(titles).not.toContain("old 0");
	});

	test("refuses a missing or overlong title, an overlong body, and an unknown tone", async () => {
		const jar = await signIn("alice");
		const long = (n: number) => "x".repeat(n);
		const bad = [
			{ tone: "neutral", title: "" },
			{ tone: "neutral", title: long(MAX_NOTIFICATION_TITLE_LENGTH + 1) },
			{ tone: "neutral", title: "ok", body: long(MAX_NOTIFICATION_BODY_LENGTH + 1) },
			{ tone: "shouting", title: "ok" },
		];
		for (const payload of bad) {
			const res = await record(jar, payload);
			expect(res.statusCode).toBe(400);
			expect(res.body).not.toContain("xxxxxxxx");
		}
		const edge = await record(jar, {
			tone: "neutral",
			title: long(MAX_NOTIFICATION_TITLE_LENGTH),
			body: long(MAX_NOTIFICATION_BODY_LENGTH),
		});
		expect(edge.statusCode).toBe(201);
	});

	test("rate-limits recording", async () => {
		const jar = await signIn("alice");
		for (let i = 0; i < NOTIFICATION_RECORDS_PER_MINUTE; i += 1) {
			expect((await record(jar, { tone: "neutral", title: `n${i}` })).statusCode).toBe(
				201,
			);
		}
		const over = await record(jar, { tone: "neutral", title: "one too many" });
		expect(over.statusCode).toBe(429);
		expect(over.json().code).toBe("RATE_LIMITED");
		// Another user has a budget of their own.
		const bob = await signIn("bob");
		expect((await record(bob, { tone: "neutral", title: "fine" })).statusCode).toBe(
			201,
		);
	});

	test("one user cannot read or change another's notifications", async () => {
		const alice = await signIn("alice");
		const bob = await signIn("bob");
		const mine = (await record(alice, { tone: "neutral", title: "alice only" })).json();

		expect((await list(bob)).notifications).toEqual([]);
		const patch = await app.inject({
			method: "PATCH",
			url: `/me/notifications/${mine.id}`,
			headers: csrfHeaders(bob, PUBLIC_URL),
			payload: { read: true },
		});
		expect(patch.statusCode).toBe(404);
		await app.inject({
			method: "POST",
			url: "/me/notifications/read-all",
			headers: csrfHeaders(bob, PUBLIC_URL),
		});
		await app.inject({
			method: "DELETE",
			url: "/me/notifications",
			headers: csrfHeaders(bob, PUBLIC_URL),
		});

		const out = await list(alice);
		expect(out.unreadCount).toBe(1);
		expect(out.notifications.map((n) => n.title)).toEqual(["alice only"]);
	});

	test("never logs the title or the body", async () => {
		const jar = await signIn("alice");
		await record(jar, {
			tone: "warning",
			title: "secret-title-7f3",
			body: "/home/alice/secret-body-9c1",
		});
		await record(jar, { tone: "neutral", title: "secret-title-7f3".repeat(20) });
		await list(jar);
		const text = JSON.stringify(logs);
		expect(text).not.toContain("secret-title-7f3");
		expect(text).not.toContain("secret-body-9c1");
	});
});
