/**
 * The workspace egress policy's admin routes (SPEC.md sections
 * 20.1, 24.9 and 24.11): administrator-only and CSRF-checked, every write
 * raises the version, a stale version gets 409, invalid entries are refused,
 * and each write leaves one audit row.
 */
import {
	CookieJar,
	csrfHeaders,
	loginAs,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import type { AdminEgressView } from "@portikus/contracts";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { buildTestServer, PUBLIC_URL } from "../testing/test-support.js";

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
	await testDb.db.deleteFrom("egress_entries").execute();
	await testDb.db.deleteFrom("egress_blocked_names").execute();
	// The worker seeds this row; truncate removed it.
	await testDb.db
		.insertInto("settings")
		.values({ id: 1, shutdown_grace_seconds: 600 })
		.execute();
	app = buildTestServer(testDb.db, mock.issuer);
	await app.listen({ port: 0, host: "127.0.0.1" });
	alice = new CookieJar();
	carol = new CookieJar();
	await loginAs(app, "alice", alice);
	await loginAs(app, "carol", carol);
	return async () => {
		await app.close();
	};
});

function send(
	jar: CookieJar,
	method: "GET" | "PUT" | "POST" | "DELETE",
	url: string,
	payload?: object,
) {
	return app.inject({
		method,
		url,
		headers: csrfHeaders(jar, PUBLIC_URL),
		...(payload ? { payload } : {}),
	});
}

async function view(): Promise<AdminEgressView> {
	return (await send(carol, "GET", "/admin/egress")).json();
}

async function audits(action: string) {
	return testDb.db
		.selectFrom("audit_events")
		.selectAll()
		.where("action", "=", action)
		.execute();
}

async function addHost(value: string, version: number, label = "") {
	return send(carol, "POST", "/admin/egress/entries", {
		version,
		kind: "host",
		value,
		label,
	});
}

test.skipIf(skip)("the default policy is open with ports 22, 80 and 443", async () => {
	const v = await view();
	expect(v).toMatchObject({
		version: 0,
		mode: "open",
		presets: [],
		ports: [22, 80, 443],
		entries: [],
		blockedSites: [],
		apply: { appliedVersion: null, appliedAt: null, error: null },
		blocked: [],
	});
	expect(v.presetCatalog.find((p) => p.id === "github")?.hosts).toContain("github.com");
});

test.skipIf(skip)("a student gets 403 on every route and changes nothing", async () => {
	const calls: [Parameters<typeof send>[1], string, object?][] = [
		["GET", "/admin/egress"],
		["PUT", "/admin/egress/mode", { version: 0, mode: "allow-list" }],
		["PUT", "/admin/egress/presets", { version: 0, presets: ["github"] }],
		["PUT", "/admin/egress/ports", { version: 0, ports: [443] }],
		[
			"POST",
			"/admin/egress/entries",
			{ version: 0, kind: "host", value: "a.com", label: "" },
		],
	];
	for (const [method, url, payload] of calls) {
		expect((await send(alice, method, url, payload)).statusCode).toBe(403);
	}
	expect((await view()).version).toBe(0);
});

test.skipIf(skip)("a write without the CSRF header is refused", async () => {
	const response = await app.inject({
		method: "PUT",
		url: "/admin/egress/mode",
		headers: { cookie: carol.cookieHeader() },
		payload: { version: 0, mode: "allow-list" },
	});
	expect(response.statusCode).toBe(403);
	expect((await view()).mode).toBe("open");
});

test.skipIf(skip)(
	"mode, presets and ports each raise the version and audit",
	async () => {
		let r = await send(carol, "PUT", "/admin/egress/mode", {
			version: 0,
			mode: "allow-list",
		});
		expect(r.statusCode).toBe(200);
		expect(r.json()).toMatchObject({ version: 1, mode: "allow-list" });
		r = await send(carol, "PUT", "/admin/egress/presets", {
			version: 1,
			presets: ["github", "npm"],
		});
		expect(r.json()).toMatchObject({ version: 2, presets: ["github", "npm"] });
		r = await send(carol, "PUT", "/admin/egress/ports", {
			version: 2,
			ports: [443, 22],
		});
		expect(r.json()).toMatchObject({ version: 3, ports: [22, 443] });

		const [mode] = await audits("egress.mode_changed");
		expect(mode?.metadata).toEqual({ from: "open", to: "allow-list" });
		expect(mode?.actor).toMatch(/^user:/);
		expect((await audits("egress.presets_changed"))[0]?.metadata).toEqual({
			presets: ["github", "npm"],
		});
		expect((await audits("egress.ports_changed"))[0]?.metadata).toEqual({
			ports: [22, 443],
		});
	},
);

test.skipIf(skip)("a stale version gets 409 and changes nothing", async () => {
	await send(carol, "PUT", "/admin/egress/mode", { version: 0, mode: "allow-list" });
	const stale = [
		() => send(carol, "PUT", "/admin/egress/mode", { version: 0, mode: "open" }),
		() =>
			send(carol, "PUT", "/admin/egress/presets", { version: 0, presets: ["github"] }),
		() => send(carol, "PUT", "/admin/egress/ports", { version: 0, ports: [443] }),
		() => addHost("example.edu", 0),
	];
	for (const call of stale) {
		const r = await call();
		expect(r.statusCode).toBe(409);
		expect(r.json().code).toBe("EGRESS_VERSION_STALE");
	}
	const v = await view();
	expect(v).toMatchObject({ version: 1, mode: "allow-list", presets: [], entries: [] });
	expect(await audits("egress.presets_changed")).toEqual([]);
	expect(await audits("egress.entry_added")).toEqual([]);
});

test.skipIf(skip)(
	"entries are added, updated and removed with audit rows",
	async () => {
		let r = await addHost("Example.EDU", 0, "Campus");
		expect(r.statusCode).toBe(200);
		const entry = r.json().entries[0];
		expect(entry).toMatchObject({
			kind: "host",
			value: "example.edu",
			label: "Campus",
		});
		const [added] = await audits("egress.entry_added");
		expect(added?.target).toBe(entry.id);
		expect(added?.metadata).toEqual({
			kind: "host",
			value: "example.edu",
			label: "Campus",
		});

		r = await send(carol, "PUT", `/admin/egress/entries/${entry.id}`, {
			version: 1,
			kind: "range",
			value: "203.0.113.0/24",
			label: "Lab",
		});
		expect(r.statusCode).toBe(200);
		expect(r.json().entries[0]).toMatchObject({
			kind: "range",
			value: "203.0.113.0/24",
		});
		expect((await audits("egress.entry_updated"))[0]?.metadata).toEqual({
			from: { kind: "host", value: "example.edu", label: "Campus" },
			to: { kind: "range", value: "203.0.113.0/24", label: "Lab" },
		});

		r = await send(carol, "DELETE", `/admin/egress/entries/${entry.id}?version=1`);
		expect(r.statusCode).toBe(409);
		r = await send(carol, "DELETE", `/admin/egress/entries/${entry.id}?version=2`);
		expect(r.statusCode).toBe(200);
		expect(r.json()).toMatchObject({ version: 3, entries: [] });
		expect((await audits("egress.entry_removed"))[0]?.metadata).toEqual({
			kind: "range",
			value: "203.0.113.0/24",
			label: "Lab",
		});
	},
);

test.skipIf(skip)("a missing entry is 404 and does not raise the version", async () => {
	const id = crypto.randomUUID();
	let r = await send(carol, "PUT", `/admin/egress/entries/${id}`, {
		version: 0,
		kind: "host",
		value: "a.com",
		label: "",
	});
	expect(r.statusCode).toBe(404);
	r = await send(carol, "DELETE", `/admin/egress/entries/${id}?version=0`);
	expect(r.statusCode).toBe(404);
	r = await send(carol, "DELETE", "/admin/egress/entries/not-a-uuid?version=0");
	expect(r.statusCode).toBe(400);
	r = await send(carol, "DELETE", `/admin/egress/entries/${id}`);
	expect(r.statusCode).toBe(400);
	expect((await view()).version).toBe(0);
});

test.skipIf(skip)(
	"a URL, wildcard, address as host or denied range is refused",
	async () => {
		const bad = [
			{ kind: "host", value: "https://github.com" },
			{ kind: "host", value: "*.github.com" },
			{ kind: "host", value: "203.0.113.5" },
			{ kind: "host", value: "localhost" },
			{ kind: "range", value: "10.0.0.0/8" },
			{ kind: "range", value: "169.254.169.254/32" },
			{ kind: "range", value: "0.0.0.0/0" },
			{ kind: "range", value: "github.com" },
		];
		for (const b of bad) {
			const r = await send(carol, "POST", "/admin/egress/entries", {
				version: 0,
				label: "",
				...b,
			});
			expect(r.statusCode, b.value).toBe(400);
			expect(r.json().code).toBe("VALIDATION_FAILED");
		}
		const r = await send(carol, "POST", "/admin/egress/entries", {
			version: 0,
			kind: "range",
			value: "10.0.0.0/8",
			label: "",
		});
		expect(r.json().message).toMatch(/private range 10\.0\.0\.0\/8/);
		expect((await view()).version).toBe(0);
	},
);

test.skipIf(skip)("a duplicate entry is 409 and rolls the version back", async () => {
	await addHost("example.edu", 0);
	const r = await addHost("example.edu", 1);
	expect(r.statusCode).toBe(409);
	expect(r.json().code).toBe("EGRESS_ENTRY_EXISTS");
	expect((await view()).version).toBe(1);
});

test.skipIf(skip)("at most 500 host names and 100 ranges", async () => {
	await testDb.db
		.insertInto("egress_entries")
		.values(
			Array.from({ length: 500 }, (_, i) => ({
				kind: "host",
				value: `h${i}.example.com`,
				label: "",
			})),
		)
		.execute();
	await testDb.db
		.insertInto("egress_entries")
		.values(
			Array.from({ length: 100 }, (_, i) => ({
				kind: "range",
				value: `203.0.${i}.0/24`,
				label: "",
			})),
		)
		.execute();
	let r = await addHost("one-more.com", 0);
	expect(r.statusCode).toBe(409);
	expect(r.json().code).toBe("EGRESS_LIMIT_REACHED");
	r = await send(carol, "POST", "/admin/egress/entries", {
		version: 0,
		kind: "range",
		value: "198.51.100.0/24",
		label: "",
	});
	expect(r.statusCode).toBe(409);
	const range = await testDb.db
		.selectFrom("egress_entries")
		.select("id")
		.where("kind", "=", "range")
		.executeTakeFirstOrThrow();
	r = await send(carol, "PUT", `/admin/egress/entries/${range.id}`, {
		version: 0,
		kind: "host",
		value: "switch.com",
		label: "",
	});
	expect(r.statusCode).toBe(409);
	expect((await view()).version).toBe(0);
});

test.skipIf(skip)("the blocked list is the site-wide top 20 over 7 days", async () => {
	const today = new Date();
	const day = (n: number) =>
		new Date(today.getTime() - n * 86_400_000).toISOString().slice(0, 10);
	await testDb.db
		.insertInto("egress_blocked_names")
		.values([
			{ day: day(0), name: "a.example", source: "dns", count: 3 },
			{ day: day(1), name: "a.example", source: "tls", count: 2 },
			{ day: day(0), name: "b.example", source: "dns", count: 4 },
			{ day: day(9), name: "old.example", source: "dns", count: 100 },
			...Array.from({ length: 25 }, (_, i) => ({
				day: day(2),
				name: `n${String(i).padStart(2, "0")}.example`,
				source: "dns",
				count: 1,
			})),
		])
		.execute();
	const { blocked } = await view();
	expect(blocked).toHaveLength(20);
	expect(blocked.slice(0, 2)).toEqual([
		{ name: "a.example", count: 5 },
		{ name: "b.example", count: 4 },
	]);
	expect(blocked.some((b) => b.name === "old.example")).toBe(false);
});

test.skipIf(skip)(
	"before the worker seeds settings, reads and writes are 404",
	async () => {
		await testDb.db.deleteFrom("settings").execute();
		expect((await send(carol, "GET", "/admin/egress")).statusCode).toBe(404);
		expect(
			(
				await send(carol, "PUT", "/admin/egress/mode", {
					version: 0,
					mode: "allow-list",
				})
			).statusCode,
		).toBe(404);
	},
);

test.skipIf(skip)("the apply status comes from the worker's columns", async () => {
	await testDb.db
		.updateTable("settings")
		.set({
			egress_applied_version: 4,
			egress_applied_at: "2026-09-27T10:00:00Z",
			egress_apply_error: "HELPER_TIMEOUT",
		})
		.where("id", "=", 1)
		.execute();
	expect((await view()).apply).toEqual({
		appliedVersion: 4,
		appliedAt: "2026-09-27T10:00:00.000Z",
		error: "HELPER_TIMEOUT",
	});
});

describe("blocked sites (ADR 0043)", () => {
	function addBlock(value: string, version: number, label = "") {
		return send(carol, "POST", "/admin/egress/blocked-sites", {
			version,
			value,
			label,
		});
	}

	test.skipIf(skip)(
		"add, edit and remove each raise the version and leave one audit row",
		async () => {
			let r = await addBlock("  Games.Example.COM ", 0, "Games");
			expect(r.statusCode).toBe(200);
			let v: AdminEgressView = r.json();
			expect(v.version).toBe(1);
			expect(v.blockedSites).toMatchObject([
				{ value: "games.example.com", label: "Games" },
			]);
			const id = v.blockedSites[0]?.id as string;
			expect(await audits("egress.block_added")).toHaveLength(1);

			r = await send(carol, "PUT", `/admin/egress/blocked-sites/${id}`, {
				version: 1,
				value: "play.example.com",
				label: "",
			});
			expect(r.statusCode).toBe(200);
			v = r.json();
			expect(v.blockedSites).toMatchObject([
				{ id, value: "play.example.com", label: "" },
			]);
			const updated = await audits("egress.block_updated");
			expect(updated).toHaveLength(1);
			expect(updated[0]?.metadata).toEqual({
				from: { value: "games.example.com", label: "Games" },
				to: { value: "play.example.com", label: "" },
			});

			r = await send(carol, "DELETE", `/admin/egress/blocked-sites/${id}?version=2`);
			expect(r.statusCode).toBe(200);
			v = r.json();
			expect(v.version).toBe(3);
			expect(v.blockedSites).toEqual([]);
			expect(await audits("egress.block_removed")).toHaveLength(1);
		},
	);

	test.skipIf(skip)(
		"a URL, wildcard or address is refused like an allow entry",
		async () => {
			for (const value of ["https://a.com/x", "*.a.com", "8.8.8.8", "localhost"]) {
				const r = await addBlock(value, 0);
				expect(r.statusCode).toBe(400);
				expect(r.json().code).toBe("VALIDATION_FAILED");
			}
			expect((await view()).version).toBe(0);
		},
	);

	test.skipIf(skip)("a student gets 403; a stale version gets 409", async () => {
		const r = await send(alice, "POST", "/admin/egress/blocked-sites", {
			version: 0,
			value: "a.com",
			label: "",
		});
		expect(r.statusCode).toBe(403);
		await addBlock("a.com", 0);
		const stale = await addBlock("b.com", 0);
		expect(stale.statusCode).toBe(409);
		expect(stale.json().code).toBe("EGRESS_VERSION_STALE");
		expect((await view()).blockedSites.map((b) => b.value)).toEqual(["a.com"]);
	});

	test.skipIf(skip)(
		"a duplicate is 409, a missing one 404, and neither raises the version",
		async () => {
			await addBlock("a.com", 0);
			const dup = await addBlock("a.com", 1);
			expect(dup.statusCode).toBe(409);
			expect(dup.json()).toMatchObject({
				code: "EGRESS_ENTRY_EXISTS",
				message: "That site is already blocked",
			});
			const missing = "33333333-3333-4333-8333-333333333333";
			const put = await send(carol, "PUT", `/admin/egress/blocked-sites/${missing}`, {
				version: 1,
				value: "b.com",
				label: "",
			});
			expect(put.statusCode).toBe(404);
			const del = await send(
				carol,
				"DELETE",
				`/admin/egress/blocked-sites/${missing}?version=1`,
			);
			expect(del.statusCode).toBe(404);
			expect((await view()).version).toBe(1);
		},
	);

	test.skipIf(skip)("the same name may be allowed and blocked at once", async () => {
		expect((await addHost("example.edu", 0)).statusCode).toBe(200);
		expect((await addBlock("example.edu", 1)).statusCode).toBe(200);
	});

	test.skipIf(skip)("at most 500 blocked sites", async () => {
		await testDb.db
			.insertInto("egress_blocked_entries")
			.values(
				Array.from({ length: 500 }, (_, i) => ({
					value: `b${i}.example.com`,
					label: "",
				})),
			)
			.execute();
		const r = await addBlock("one-more.com", 0);
		expect(r.statusCode).toBe(409);
		expect(r.json().code).toBe("EGRESS_LIMIT_REACHED");
		expect((await view()).version).toBe(0);
	});
});
