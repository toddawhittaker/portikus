import { createSocket } from "node:dgram";
import { connect } from "node:net";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import { collectingLogger } from "@portikus/observability/testing";
import { sql } from "kysely";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "vitest";
import {
	BLOCKED_NAMES_PER_DAY,
	type BlockedCounter,
	countableName,
	createBlockedCounter,
	nxdomain,
	OTHER_NAMES,
	queryName,
} from "./egress-blocked.js";

/** A DNS query for `name`, type A unless given, with the given id and RD set. */
function query(name: string, id = 0x1234, type = 1): Buffer {
	const labels = name
		.split(".")
		.map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)]));
	const header = Buffer.alloc(12);
	header.writeUInt16BE(id, 0);
	header.writeUInt8(0x01, 2); // RD
	header.writeUInt16BE(1, 4);
	const question = Buffer.from([0, 0, 0, 0, 1]);
	question.writeUInt16BE(type, 1);
	return Buffer.concat([header, ...labels, question]);
}

describe("DNS parsing", () => {
	test("reads the question and answers NXDOMAIN with the id and question kept", () => {
		const q = query("example.com");
		const parsed = queryName(q);
		expect(parsed?.name).toBe("example.com");
		const r = nxdomain(q, parsed?.end ?? 0);
		expect(r.readUInt16BE(0)).toBe(0x1234);
		expect(r.readUInt8(2) & 0x80).toBe(0x80); // a response
		expect(r.readUInt8(2) & 0x01).toBe(0x01); // RD kept
		expect(r.readUInt8(3) & 0x0f).toBe(3); // NXDOMAIN
		expect(r.readUInt16BE(4)).toBe(1);
		expect(r.readUInt16BE(6)).toBe(0);
		expect(r.subarray(12).equals(q.subarray(12))).toBe(true);
	});

	test.each([
		["too short", Buffer.alloc(5)],
		[
			"a response",
			(() => {
				const q = query("a.com");
				q.writeUInt8(0x81, 2);
				return q;
			})(),
		],
		[
			"no question",
			(() => {
				const q = query("a.com");
				q.writeUInt16BE(0, 4);
				return q;
			})(),
		],
		[
			"a compression pointer",
			Buffer.concat([
				query("a.com").subarray(0, 12),
				Buffer.from([0xc0, 0x0c, 0, 1, 0, 1]),
			]),
		],
		["a truncated name", query("example.com").subarray(0, 16)],
	])("refuses %s", (_what, msg) => {
		expect(queryName(msg)).toBeNull();
	});
});

describe("countableName never keeps an address", () => {
	test.each([
		["Example.COM.", "example.com"],
		["_dmarc.example.com", "_dmarc.example.com"],
	])("%s counts as %s", (raw, want) => {
		expect(countableName(raw)).toBe(want);
	});

	test.each([
		"2.0.200.10.in-addr.arpa",
		"1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2.ip6.arpa",
		"10.200.0.2",
		"",
		"a b.com",
		"a.com\n10.200.0.2",
		"x".repeat(254),
	])("drops %j", (raw) => {
		expect(countableName(raw)).toBeNull();
	});
});

const skip = !hasTestDb();
let tdb: TestDb;

beforeAll(async () => {
	if (skip) return;
	tdb = await createTestDb();
});

afterAll(async () => {
	if (skip) return;
	await tdb.close();
});

let counter: BlockedCounter | null = null;
let now = new Date("2026-09-27T12:00:00Z");

beforeEach(async () => {
	now = new Date("2026-09-27T12:00:00Z");
	if (skip) return;
	await tdb.truncate();
});

afterEach(async () => {
	await counter?.close();
	counter = null;
});

async function rows() {
	return tdb.db
		.selectFrom("egress_blocked_names")
		.select([
			sql<string>`to_char(day, 'YYYY-MM-DD')`.as("day"),
			"name",
			"source",
			"count",
		])
		.orderBy("name")
		.orderBy("source")
		.execute();
}

async function listening(): Promise<BlockedCounter> {
	counter = createBlockedCounter({
		db: tdb.db,
		logger: collectingLogger().logger,
		now: () => now,
		dnsPort: 0,
		logPort: 0,
	});
	await counter.listen();
	return counter;
}

function udpAsk(port: number, msg: Buffer): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const s = createSocket("udp4");
		s.once("message", (m) => {
			s.close();
			resolve(m);
		});
		s.once("error", reject);
		s.send(msg, port, "127.0.0.1");
	});
}

function tcpAsk(port: number, msgs: Buffer[]): Promise<Buffer[]> {
	return new Promise((resolve, reject) => {
		const s = connect(port, "127.0.0.1");
		const out: Buffer[] = [];
		let buf = Buffer.alloc(0);
		s.on("data", (d: Buffer) => {
			buf = Buffer.concat([buf, d]);
			while (buf.length >= 2 && buf.length >= 2 + buf.readUInt16BE(0)) {
				out.push(buf.subarray(2, 2 + buf.readUInt16BE(0)));
				buf = buf.subarray(2 + buf.readUInt16BE(0));
			}
			if (out.length === msgs.length) {
				s.end();
				resolve(out);
			}
		});
		s.on("error", reject);
		for (const m of msgs) {
			const len = Buffer.alloc(2);
			len.writeUInt16BE(m.length);
			// Split the frame to prove reassembly.
			s.write(Buffer.concat([len, m.subarray(0, 3)]));
			s.write(m.subarray(3));
		}
	});
}

describe.skipIf(skip)("the blocked-name counter (ADR 0038)", () => {
	test("answers NXDOMAIN over UDP and TCP, on loopback, and counts each name", async () => {
		const c = await listening();
		const { dns, dnsTcp } = c.ports();
		const r = await udpAsk(dns, query("example.com", 7));
		expect(r.readUInt16BE(0)).toBe(7);
		expect(r.readUInt8(3) & 0x0f).toBe(3);
		const [a, b] = await tcpAsk(dnsTcp, [
			query("evil.test", 8),
			query("Example.com", 9),
		]);
		expect(a?.readUInt16BE(0)).toBe(8);
		expect((b?.readUInt8(3) ?? 0) & 0x0f).toBe(3);
		await c.flush();
		expect(await rows()).toEqual([
			{ day: "2026-09-27", name: "evil.test", source: "dns", count: 1 },
			{ day: "2026-09-27", name: "example.com", source: "dns", count: 2 },
		]);
	});

	test("AAAA and HTTPS queries are answered NXDOMAIN but only A queries count", async () => {
		const c = await listening();
		const { dns } = c.ports();
		for (const type of [1, 28, 65]) {
			const r = await udpAsk(dns, query("example.com", type, type));
			expect(r.readUInt16BE(0)).toBe(type);
			expect(r.readUInt8(3) & 0x0f).toBe(3);
		}
		await c.flush();
		expect(await rows()).toEqual([
			{ day: "2026-09-27", name: "example.com", source: "dns", count: 1 },
		]);
	});

	test("Squid's name-only lines count as tls; a dash or an address counts nothing", async () => {
		const c = await listening();
		const s = createSocket("udp4");
		await new Promise<void>((r) =>
			s.send("blocked.example\n-\n10.200.0.2\n", c.ports().log, "127.0.0.1", () => r()),
		);
		s.close();
		await new Promise((r) => setTimeout(r, 50));
		await c.flush();
		expect(await rows()).toEqual([
			{ day: "2026-09-27", name: "blocked.example", source: "tls", count: 1 },
		]);
	});

	test("counts add up across flushes", async () => {
		const c = await listening();
		c.count("a.example", "dns");
		await c.flush();
		c.count("a.example", "dns");
		c.count("a.example", "dns");
		await c.flush();
		expect((await rows())[0]?.count).toBe(3);
	});

	test("stores no address: no column for one, and reverse lookups are not kept", async () => {
		const c = await listening();
		await udpAsk(c.ports().dns, query("2.0.200.10.in-addr.arpa"));
		await c.flush();
		expect(await rows()).toEqual([]);
		const cols = await sql<{ column_name: string }>`
			select column_name from information_schema.columns where table_name = 'egress_blocked_names'
			order by column_name`.execute(tdb.db);
		expect(cols.rows.map((r) => r.column_name)).toEqual([
			"count",
			"day",
			"name",
			"source",
		]);
	});

	test(`caps a day at ${BLOCKED_NAMES_PER_DAY} names; the rest count as "(other names)"`, async () => {
		const c = await listening();
		for (let i = 0; i < BLOCKED_NAMES_PER_DAY - 1; i++) c.count(`n${i}.example`, "dns");
		await c.flush();
		c.count("last.example", "dns");
		c.count("over1.example", "dns");
		c.count("over2.example", "tls");
		c.count("n0.example", "dns"); // already known: still counted under its name
		await c.flush();
		const all = await rows();
		expect(all.filter((r) => r.name !== OTHER_NAMES)).toHaveLength(
			BLOCKED_NAMES_PER_DAY,
		);
		expect(all.find((r) => r.name === "n0.example")?.count).toBe(2);
		expect(all.filter((r) => r.name === OTHER_NAMES)).toEqual([
			{ day: "2026-09-27", name: OTHER_NAMES, source: "dns", count: 1 },
			{ day: "2026-09-27", name: OTHER_NAMES, source: "tls", count: 1 },
		]);
		// A new day starts a new cap.
		now = new Date("2026-09-28T00:00:01Z");
		c.count("fresh.example", "dns");
		await c.flush();
		expect((await rows()).find((r) => r.name === "fresh.example")?.day).toBe(
			"2026-09-28",
		);
	});

	test("a flood between flushes stays bounded in memory", async () => {
		const c = await listening();
		for (let i = 0; i < BLOCKED_NAMES_PER_DAY + 500; i++)
			c.count(`f${i}.example`, "dns");
		await c.flush();
		const all = await rows();
		expect(all).toHaveLength(BLOCKED_NAMES_PER_DAY + 1);
		expect(all.find((r) => r.name === OTHER_NAMES)?.count).toBe(500);
	});

	test("prunes counts older than 30 days", async () => {
		const c = await listening();
		await tdb.db
			.insertInto("egress_blocked_names")
			.values([
				{ day: "2026-08-27", name: "old.example", source: "dns", count: 1 },
				{ day: "2026-08-28", name: "kept.example", source: "dns", count: 1 },
			])
			.execute();
		await c.prune();
		expect((await rows()).map((r) => r.name)).toEqual(["kept.example"]);
	});
});
