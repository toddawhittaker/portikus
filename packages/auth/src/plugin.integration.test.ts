import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { authPlugin, requireRole } from "./plugin.js";
import { createSession, upsertUser } from "./sessions.js";
import { type AuthOptions, SESSION_COOKIE } from "./types.js";

const PUBLIC_URL = "http://127.0.0.1:5173";

const auth: AuthOptions = {
	publicUrl: PUBLIC_URL,
	issuerUrl: "http://127.0.0.1:3002",
	clientId: "portikus-dev",
	clientSecret: "portikus-dev-secret",
	scopes: "openid profile email",
	groupsClaim: "groups",
	studentGroup: "portikus-students",
	adminGroup: "portikus-administrators",
	cookieSecret: "a-test-cookie-secret-value",
	sessionTtlSeconds: 3600,
};

describe.skipIf(!hasTestDb())("authPlugin", () => {
	let t: TestDb;
	let app: FastifyInstance;

	beforeAll(async () => {
		t = await createTestDb();
		app = Fastify({ logger: false });
		await app.register(authPlugin, { db: t.db, auth });
		app.get("/health", async () => ({ status: "ok" }));
		app.get("/auth/me", async (request) => ({ user: request.user }));
		app.get("/workspaces", async (request) => ({ owner: request.user?.id }));
		app.post("/workspaces", async () => ({ created: true }));
		app.get(
			"/admin/workspaces",
			{ preHandler: requireRole("administrator") },
			async () => ({
				workspaces: [],
			}),
		);
		await app.ready();
	});

	afterAll(async () => {
		await app?.close();
		await t?.close();
	});

	beforeEach(async () => {
		await t.truncate();
	});

	async function signIn(
		role: "student" | "administrator" = "student",
	): Promise<string> {
		const user = await upsertUser(
			t.db,
			{
				issuer: "https://idp.example.edu",
				subject: `user-${role}`,
				email: null,
				displayName: "Test User",
				preferredUsername: `user-${role}`,
			},
			role,
		);
		const { token } = await createSession(t.db, user.id, 3600);
		return token;
	}

	test("GET /health needs no session", async () => {
		const res = await app.inject({ method: "GET", url: "/health" });
		expect(res.statusCode).toBe(200);
	});

	test("/auth/ routes need no session", async () => {
		const res = await app.inject({ method: "GET", url: "/auth/me" });
		expect(res.statusCode).toBe(200);
		expect(res.json()).toEqual({ user: null });
	});

	test("other routes are 401 without a session", async () => {
		const res = await app.inject({ method: "GET", url: "/workspaces" });
		expect(res.statusCode).toBe(401);
		expect(res.json()).toEqual({
			code: "UNAUTHORIZED",
			message: "authentication required",
		});
	});

	test("a valid session cookie identifies the user", async () => {
		const token = await signIn();
		const res = await app.inject({
			method: "GET",
			url: "/workspaces",
			headers: { cookie: `${SESSION_COOKIE}=${token}` },
		});
		expect(res.statusCode).toBe(200);
		expect(res.json().owner).toBeTruthy();
	});

	test("an unknown session cookie is 401 and cleared", async () => {
		const res = await app.inject({
			method: "GET",
			url: "/workspaces",
			headers: { cookie: `${SESSION_COOKIE}=nonsense` },
		});
		expect(res.statusCode).toBe(401);
		expect(String(res.headers["set-cookie"])).toContain(`${SESSION_COOKIE}=;`);
	});

	test("POST without CSRF evidence is 403", async () => {
		const token = await signIn();
		const res = await app.inject({
			method: "POST",
			url: "/workspaces",
			headers: { cookie: `${SESSION_COOKIE}=${token}` },
		});
		expect(res.statusCode).toBe(403);
		expect(res.json().code).toBe("FORBIDDEN");
	});

	test("POST from another origin is 403", async () => {
		const token = await signIn();
		const res = await app.inject({
			method: "POST",
			url: "/workspaces",
			headers: {
				cookie: `${SESSION_COOKIE}=${token}`,
				origin: "https://evil.example.com",
			},
		});
		expect(res.statusCode).toBe(403);
	});

	test("POST from our own origin succeeds", async () => {
		const token = await signIn();
		const res = await app.inject({
			method: "POST",
			url: "/workspaces",
			headers: { cookie: `${SESSION_COOKIE}=${token}`, origin: PUBLIC_URL },
		});
		expect(res.statusCode).toBe(200);
	});

	test("a WebSocket upgrade from another origin is 403", async () => {
		const token = await signIn();
		const res = await app.inject({
			method: "GET",
			url: "/workspaces",
			headers: {
				cookie: `${SESSION_COOKIE}=${token}`,
				origin: "https://evil.example.com",
				upgrade: "websocket",
			},
		});
		expect(res.statusCode).toBe(403);
	});

	test("requireRole keeps students out of admin routes", async () => {
		const student = await signIn("student");
		const denied = await app.inject({
			method: "GET",
			url: "/admin/workspaces",
			headers: { cookie: `${SESSION_COOKIE}=${student}` },
		});
		expect(denied.statusCode).toBe(403);

		const admin = await signIn("administrator");
		const allowed = await app.inject({
			method: "GET",
			url: "/admin/workspaces",
			headers: { cookie: `${SESSION_COOKIE}=${admin}` },
		});
		expect(allowed.statusCode).toBe(200);
	});
});
