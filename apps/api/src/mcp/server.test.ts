import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createApiKey } from "@portikus/auth";
import {
	CookieJar,
	loginAs,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import type { ApiKeyScope } from "@portikus/contracts";
import {
	createTestDb,
	hasTestDb,
	insertTestLtiMembership,
	type TestDb,
} from "@portikus/db/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { OPERATIONS, type Operation } from "../catalog/index.js";
import {
	buildTestServer,
	MATRIX_MOCK_USERS,
	PUBLIC_URL,
} from "../testing/test-support.js";
import { toolName } from "./server.js";

/**
 * The MCP server (SPEC.md sections 24.8, 24.13 and 27): a key sees only the
 * tools its owner's role and its scope allow, and every call is the route
 * itself, run as the key, with the route's own checks and audit.
 */

const skip = !hasTestDb();

let testDb: TestDb;
let mock: MockOidcProvider;
let app: FastifyInstance;
let base: string;
/** Every request but the MCP ones themselves, as its route pattern. */
let inner: string[];

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
	inner = [];
	app.addHook("onRequest", async (request) => {
		if (request.routeOptions.url !== "/mcp")
			inner.push(request.routeOptions.url ?? request.url);
	});
	base = await app.listen({ port: 0, host: "127.0.0.1" });
	return async () => {
		await app.close();
	};
});

async function signIn(user: string): Promise<{ jar: CookieJar; id: string }> {
	const jar = new CookieJar();
	await loginAs(app, user, jar);
	const me = await app.inject({
		method: "GET",
		url: "/auth/me",
		headers: { cookie: jar.cookieHeader() },
	});
	return { jar, id: me.json().id };
}

async function keyFor(
	userId: string,
	scope: ApiKeyScope,
): Promise<{ secret: string; id: string }> {
	const made = await createApiKey(testDb.db, userId, {
		name: `${scope} key`,
		scope,
		periodDays: 30,
	});
	if (!made.ok) throw new Error(`no key: ${made.reason}`);
	return { secret: made.secret, id: made.key.id };
}

async function connect(secret: string): Promise<Client> {
	const client = new Client({ name: "portikus-test", version: "1.0.0" });
	await client.connect(
		new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
			requestInit: { headers: { authorization: `Bearer ${secret}` } },
		}),
	);
	return client;
}

async function toolNames(secret: string): Promise<string[]> {
	const client = await connect(secret);
	try {
		return (await client.listTools()).tools.map((tool) => tool.name);
	} finally {
		await client.close();
	}
}

async function call(secret: string, name: string, args: Record<string, unknown> = {}) {
	const client = await connect(secret);
	try {
		const result = await client.callTool({ name, arguments: args });
		const content = result.content as { type: string; text: string }[];
		return { isError: result.isError === true, text: content[0]?.text ?? "" };
	} finally {
		await client.close();
	}
}

const NAMED: Operation[] = Object.values(OPERATIONS).filter((op) => op.tool);
const byTool = new Map(NAMED.map((op) => [toolName(op), op]));

/** The named tools listed, as their catalog records. */
function operationsOf(names: string[]): Operation[] {
	return names.flatMap((name) => byTool.get(name) ?? []);
}

/** The requests the tool calls made, once the test's own setup requests are left out. */
function innerSince(start: number): string[] {
	return inner.slice(start);
}

describe.skipIf(skip)("which tools a key lists", () => {
	test("the handshake and tools/list work through the bridge on a real server", async () => {
		const admin = await signIn("carol");
		const key = await keyFor(admin.id, "read");
		const client = await connect(key.secret);
		try {
			expect(client.getServerVersion()?.name).toBe("portikus");
			const { tools } = await client.listTools();
			const names = tools.map((tool) => tool.name);
			expect(names).toContain("find_operation");
			expect(names).toContain("run_operation");
			const users = tools.find((tool) => tool.name === "users_list");
			expect(users?.annotations?.readOnlyHint).toBe(true);
			expect(users?.inputSchema.type).toBe("object");
		} finally {
			await client.close();
		}
	});

	test("an administrator's read key lists only read tools", async () => {
		const admin = await signIn("carol");
		const names = await toolNames((await keyFor(admin.id, "read")).secret);
		const listed = operationsOf(names);
		expect(listed.length).toBeGreaterThan(0);
		expect(listed.filter((op) => op.risk !== "read").map((op) => op.name)).toEqual([]);
		expect(names).toContain("users_list");
	});

	test("an instructor's key lists no administrator tools", async () => {
		const ivy = await signIn("ivy");
		const names = await toolNames((await keyFor(ivy.id, "destructive")).secret);
		const listed = operationsOf(names);
		expect(listed.length).toBeGreaterThan(0);
		expect(
			listed.filter((op) => op.audience === "administrator").map((op) => op.name),
		).toEqual([]);
		expect(names).toContain("courses_members");
	});

	test("a write key lists change tools but no destructive ones", async () => {
		const admin = await signIn("carol");
		const names = await toolNames((await keyFor(admin.id, "write")).secret);
		const listed = operationsOf(names);
		expect(listed.some((op) => op.risk === "change")).toBe(true);
		expect(
			listed.filter((op) => op.risk === "destructive").map((op) => op.name),
		).toEqual([]);
		const destructive = NAMED.find(
			(op) => op.risk === "destructive" && op.audience !== "instructor",
		);
		expect(destructive, "the catalog names a destructive tool").toBeDefined();
		const all = await toolNames((await keyFor(admin.id, "destructive")).secret);
		expect(all).toContain(toolName(destructive as Operation));
		expect(byTool.get(toolName(destructive as Operation))).toBeDefined();
	});

	test("a destructive tool says so, and a change tool is not read-only", async () => {
		const admin = await signIn("carol");
		const client = await connect((await keyFor(admin.id, "destructive")).secret);
		try {
			const { tools } = await client.listTools();
			for (const tool of tools) {
				const op = byTool.get(tool.name);
				if (!op) continue;
				expect(tool.annotations?.readOnlyHint, tool.name).toBe(op.risk === "read");
				if (op.risk !== "read") {
					expect(tool.annotations?.destructiveHint, tool.name).toBe(
						op.risk === "destructive",
					);
				}
			}
		} finally {
			await client.close();
		}
	});
});

describe.skipIf(skip)("find_operation", () => {
	test("finds operations by word, only among those the key may run, ten at most", async () => {
		const admin = await signIn("carol");
		const read = await keyFor(admin.id, "read");
		const { text } = await call(read.secret, "find_operation", {
			query: "users workspaces",
		});
		const found = JSON.parse(text) as { name: string; risk: string; input: object }[];
		expect(found.length).toBeGreaterThan(0);
		expect(found.length).toBeLessThanOrEqual(10);
		expect(found.every((one) => one.risk === "read")).toBe(true);
		expect(found.every((one) => typeof one.input === "object")).toBe(true);
	});

	test("an instructor finds no administrator operations", async () => {
		const ivy = await signIn("ivy");
		const key = await keyFor(ivy.id, "destructive");
		const { text } = await call(key.secret, "find_operation", {
			query: "users disable list",
		});
		const names = (JSON.parse(text) as { name: string }[]).map((one) => one.name);
		const admins = new Set(
			Object.values(OPERATIONS)
				.filter((op) => op.audience === "administrator")
				.map((op) => op.name),
		);
		expect(names.filter((name) => admins.has(name))).toEqual([]);
	});
});

describe.skipIf(skip)("run_operation and the named tools", () => {
	test("a destructive operation with a write key is refused before any request is made", async () => {
		const admin = await signIn("carol");
		const key = await keyFor(admin.id, "write");
		const before = inner.length;
		const destructive = Object.values(OPERATIONS).find(
			(op) => op.risk === "destructive" && op.audience !== "instructor",
		) as Operation;
		const result = await call(key.secret, "run_operation", {
			operation: destructive.name,
			input: { path: { id: admin.id } },
		});
		expect(result.isError).toBe(true);
		expect(JSON.parse(result.text).code).toBe("SCOPE_REQUIRED");
		expect(innerSince(before)).toEqual([]);
	});

	test.each(["no_such.operation", "root_shell.open", "users.change_password"])(
		"%s, unknown or not exposed, is refused before any request is made",
		async (name) => {
			const admin = await signIn("carol");
			const key = await keyFor(admin.id, "destructive");
			const before = inner.length;
			const result = await call(key.secret, "run_operation", { operation: name });
			expect(result.isError).toBe(true);
			expect(JSON.parse(result.text).code).toBe("NOT_AVAILABLE_TO_API_KEYS");
			expect(innerSince(before)).toEqual([]);
		},
	);

	test("an instructor's run_operation of an administrator operation is refused before any request", async () => {
		const ivy = await signIn("ivy");
		const key = await keyFor(ivy.id, "destructive");
		const before = inner.length;
		const result = await call(key.secret, "run_operation", { operation: "users.list" });
		expect(result.isError).toBe(true);
		expect(JSON.parse(result.text).code).toBe("FORBIDDEN");
		expect(innerSince(before)).toEqual([]);
	});

	test("a tool call writes the route's own audit row, by key, with the key's id", async () => {
		const admin = await signIn("carol");
		const alice = await signIn("alice");
		const key = await keyFor(admin.id, "write");
		const before = inner.length;
		const result = await call(key.secret, "users_disable", { path: { id: alice.id } });
		expect(result.isError).toBe(false);
		const row = await testDb.db
			.selectFrom("audit_events")
			.select(["actor", "target", "via", "api_key_id"])
			.where("action", "=", "user.disabled")
			.executeTakeFirstOrThrow();
		expect(row).toEqual({
			actor: `user:${admin.id}`,
			target: alice.id,
			via: "api_key",
			api_key_id: key.id,
		});
		expect(innerSince(before)).toEqual(["/admin/users/:id/disable"]);
	});

	test("run_operation runs the route as the key, like a named tool", async () => {
		const admin = await signIn("carol");
		const key = await keyFor(admin.id, "read");
		const result = await call(key.secret, "run_operation", { operation: "users.list" });
		expect(result.isError).toBe(false);
		const http = await app.inject({
			method: "GET",
			url: "/admin/users",
			headers: { authorization: `Bearer ${key.secret}` },
		});
		expect(JSON.parse(result.text)).toEqual(http.json());
	});

	test("an instructor on another instructor's course gets the refusal the HTTP route gives", async () => {
		const ivy = await signIn("ivy");
		// Another person teaches this course; ivy does not.
		const other = await signIn("bob");
		await testDb.db
			.updateTable("users")
			.set({ role: "instructor" })
			.where("id", "=", other.id)
			.execute();
		const courseId = await insertTestLtiMembership(testDb.db, other.id, {
			role: "instructor",
		});
		const key = await keyFor(ivy.id, "read");
		const http = await app.inject({
			method: "GET",
			url: `/courses/${courseId}/members`,
			headers: { authorization: `Bearer ${key.secret}` },
		});
		expect(http.statusCode).toBeGreaterThanOrEqual(400);
		for (const [name, args] of [
			["courses_members", { path: { courseId } }],
			[
				"run_operation",
				{ operation: "courses.members", input: { path: { courseId } } },
			],
		] as const) {
			const result = await call(key.secret, name, args);
			expect(result.isError, name).toBe(true);
			expect(JSON.parse(result.text), name).toEqual(http.json());
		}
	});

	test("a path value cannot reach another route", async () => {
		const admin = await signIn("carol");
		const key = await keyFor(admin.id, "write");
		const before = inner.length;
		const result = await call(key.secret, "users_disable", {
			path: { id: "../../me/api-keys" },
		});
		expect(result.isError).toBe(true);
		expect(innerSince(before)).toEqual(["/admin/users/:id/disable"]);
		const keys = await testDb.db.selectFrom("api_keys").select("revoked_at").execute();
		expect(keys.every((row) => row.revoked_at === null)).toBe(true);
	});

	test("a missing path value is refused before any request", async () => {
		const admin = await signIn("carol");
		const key = await keyFor(admin.id, "write");
		const before = inner.length;
		const result = await call(key.secret, "users_disable", {});
		expect(result.isError).toBe(true);
		expect(JSON.parse(result.text).code).toBe("VALIDATION_FAILED");
		expect(innerSince(before)).toEqual([]);
	});

	test("tool output never carries a secret field or the key itself", async () => {
		const admin = await signIn("carol");
		const key = await keyFor(admin.id, "read");
		const client = await connect(key.secret);
		try {
			const { tools } = await client.listTools();
			let ran = 0;
			for (const tool of tools) {
				const op = byTool.get(tool.name);
				const needsPath = Object.keys(
					(tool.inputSchema.properties ?? {}) as Record<string, unknown>,
				).includes("path");
				if (!op || needsPath) continue;
				const result = await client.callTool({ name: tool.name, arguments: {} });
				const text = (result.content as { text: string }[])[0]?.text ?? "";
				expect(text, tool.name).not.toContain(key.secret);
				expect(secretFields(JSON.parse(text)), tool.name).toEqual([]);
				ran += 1;
			}
			expect(ran).toBeGreaterThan(5);
		} finally {
			await client.close();
		}
	});
});

/** Paths to fields named like a secret that hold a non-empty string. */
function secretFields(value: unknown, path = "$"): string[] {
	if (Array.isArray(value))
		return value.flatMap((item, i) => secretFields(item, `${path}[${i}]`));
	if (typeof value !== "object" || value === null) return [];
	return Object.entries(value).flatMap(([name, inner]) => {
		const here = `${path}.${name}`;
		const named = /secret|password|token|private_?key|credential/i.test(name);
		return [
			...(named && typeof inner === "string" && inner !== "" ? [here] : []),
			...secretFields(inner, here),
		];
	});
}
