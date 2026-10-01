import { createSocket, type Socket as UdpSocket } from "node:dgram";
import { createServer, type Server, type Socket } from "node:net";
import type { Database } from "@portikus/db";
import type { Logger } from "@portikus/observability";
import { type Kysely, sql } from "kysely";
import { utcDay } from "./package-survey.js";

/**
 * The blocked-name counter (ADR 0038). Our egress dnsmasq sends
 * every unlisted name here; this answers NXDOMAIN and counts the name. The
 * workspace Squid sends each refused TLS or HTTP name as a UDP line. Only
 * dnsmasq and Squid talk to it, on loopback, so it never learns which
 * workspace asked: counts are site-wide by construction (SPEC.md §20.1).
 */

export const BLOCKED_DNS_PORT = 5399;
export const BLOCKED_LOG_PORT = 5398;
export const BLOCKED_NAMES_PER_DAY = 2000;
export const BLOCKED_RETENTION_DAYS = 30;
export const OTHER_NAMES = "(other names)";
const FLUSH_SECONDS = 10;
const PRUNE_HOURS = 6;
const MAX_TCP_CONNECTIONS = 64;
const TCP_IDLE_MS = 10_000;
// A client asks A, AAAA and HTTPS for one name; only A is counted so each lookup counts once.
const QTYPE_A = 1;

export type BlockedSource = "dns" | "tls";

/**
 * A name worth counting, lower-cased, or null. Anything that could hold an
 * address (a dotted IPv4 literal, a reverse lookup) or is not name-shaped
 * is dropped, so the table never stores an address.
 */
export function countableName(raw: string): string | null {
	const name = raw.trim().toLowerCase().replace(/\.$/, "");
	if (name.length === 0 || name.length > 253) return null;
	if (!/^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/.test(name)) return null;
	if (name.endsWith(".in-addr.arpa") || name.endsWith(".ip6.arpa")) return null;
	if (/^[0-9.]+$/.test(name)) return null;
	return name;
}

/** The first question's name and type in a DNS query, or null for anything malformed. */
export function queryName(
	msg: Buffer,
): { name: string; type: number; end: number } | null {
	if (msg.length < 12) return null;
	if ((msg.readUInt8(2) & 0x80) !== 0) return null; // a response, not a query
	if (msg.readUInt16BE(4) < 1) return null;
	const labels: string[] = [];
	let off = 12;
	for (;;) {
		if (off >= msg.length) return null;
		const len = msg.readUInt8(off);
		off += 1;
		if (len === 0) break;
		if (len > 63 || off + len > msg.length) return null; // no compression in a question
		labels.push(msg.toString("latin1", off, off + len));
		off += len;
	}
	if (off + 4 > msg.length) return null;
	return { name: labels.join("."), type: msg.readUInt16BE(off), end: off + 4 };
}

/** NXDOMAIN for a query: its id, opcode and RD kept, the question echoed, no records. */
export function nxdomain(msg: Buffer, questionEnd: number): Buffer {
	const out = Buffer.alloc(questionEnd);
	msg.copy(out, 0, 0, questionEnd);
	out.writeUInt8(0x80 | (msg.readUInt8(2) & 0x79), 2); // QR, opcode, RD
	out.writeUInt8(0x80 | 3, 3); // RA, NXDOMAIN
	out.writeUInt16BE(1, 4);
	out.writeUInt16BE(0, 6);
	out.writeUInt16BE(0, 8);
	out.writeUInt16BE(0, 10);
	return out;
}

export interface BlockedCounterOptions {
	db: Kysely<Database>;
	logger: Logger;
	now?: () => Date;
	dnsPort?: number;
	logPort?: number;
}

export interface BlockedCounter {
	/** Record one refused name. */
	count(raw: string, source: BlockedSource): void;
	/** Write buffered counts to the database. */
	flush(): Promise<void>;
	/** Delete counts older than the retention. */
	prune(): Promise<void>;
	/** The ports actually bound, once listening. */
	ports(): { dns: number; dnsTcp: number; log: number };
	listen(): Promise<void>;
	close(): Promise<void>;
}

export function createBlockedCounter(options: BlockedCounterOptions): BlockedCounter {
	const { db, logger } = options;
	const now = options.now ?? (() => new Date());
	// Key: day, source and name. Bounded like the table, so a flood between flushes stays small.
	let pending = new Map<string, number>();
	let udp: UdpSocket | null = null;
	let tcp: Server | null = null;
	let log: UdpSocket | null = null;
	const sockets = new Set<Socket>();

	function count(raw: string, source: BlockedSource): void {
		const name = countableName(raw);
		if (!name) return;
		const day = utcDay(now());
		let key = `${day}\t${source}\t${name}`;
		if (!pending.has(key) && pending.size >= BLOCKED_NAMES_PER_DAY) {
			key = `${day}\t${source}\t${OTHER_NAMES}`;
		}
		pending.set(key, (pending.get(key) ?? 0) + 1);
	}

	async function flush(): Promise<void> {
		if (pending.size === 0) return;
		const batch = pending;
		pending = new Map();
		const byDay = new Map<string, { source: string; name: string; n: number }[]>();
		for (const [key, n] of batch) {
			const [day = "", source = "", name = ""] = key.split("\t");
			const list = byDay.get(day) ?? [];
			list.push({ source, name, n });
			byDay.set(day, list);
		}
		for (const [day, rows] of byDay) {
			await db.transaction().execute(async (trx) => {
				// Serialise flushes for the day so two cannot both pass the cap.
				await sql`select pg_advisory_xact_lock(hashtext(${`egress_blocked:${day}`}))`.execute(
					trx,
				);
				const known = new Set(
					(
						await trx
							.selectFrom("egress_blocked_names")
							.select("name")
							.distinct()
							.where("day", "=", sql<Date>`${day}::date`)
							.execute()
					).map((r) => r.name),
				);
				known.delete(OTHER_NAMES);
				const merged = new Map<string, number>();
				for (const r of rows) {
					let name = r.name;
					if (name !== OTHER_NAMES && !known.has(name)) {
						if (known.size >= BLOCKED_NAMES_PER_DAY) name = OTHER_NAMES;
						else known.add(name);
					}
					const k = `${r.source}\t${name}`;
					merged.set(k, (merged.get(k) ?? 0) + r.n);
				}
				for (const [k, n] of merged) {
					const [source = "", name = ""] = k.split("\t");
					await trx
						.insertInto("egress_blocked_names")
						.values({ day, name, source, count: n })
						.onConflict((oc) =>
							oc.columns(["day", "name", "source"]).doUpdateSet({
								count: sql`egress_blocked_names.count + excluded.count`,
							}),
						)
						.execute();
				}
			});
		}
	}

	async function prune(): Promise<void> {
		const cutoff = new Date(now().getTime() - BLOCKED_RETENTION_DAYS * 86_400_000);
		await db
			.deleteFrom("egress_blocked_names")
			.where("day", "<", sql<Date>`${utcDay(cutoff)}::date`)
			.execute();
	}

	function answerUdp(msg: Buffer, rinfo: { port: number; address: string }): void {
		const q = queryName(msg);
		if (!q) return;
		if (q.type === QTYPE_A) count(q.name, "dns");
		udp?.send(nxdomain(msg, q.end), rinfo.port, rinfo.address);
	}

	function answerTcp(socket: Socket): void {
		if (sockets.size >= MAX_TCP_CONNECTIONS) {
			socket.destroy();
			return;
		}
		sockets.add(socket);
		socket.setTimeout(TCP_IDLE_MS, () => socket.destroy());
		socket.on("close", () => sockets.delete(socket));
		socket.on("error", () => socket.destroy());
		let buf = Buffer.alloc(0);
		socket.on("data", (chunk: Buffer) => {
			buf = Buffer.concat([buf, chunk]);
			while (buf.length >= 2) {
				const len = buf.readUInt16BE(0);
				if (buf.length < 2 + len) {
					if (buf.length > 2 + 65535) socket.destroy();
					return;
				}
				const msg = buf.subarray(2, 2 + len);
				buf = buf.subarray(2 + len);
				const q = queryName(msg);
				if (!q) {
					socket.destroy();
					return;
				}
				if (q.type === QTYPE_A) count(q.name, "dns");
				const reply = nxdomain(msg, q.end);
				const framed = Buffer.alloc(2 + reply.length);
				framed.writeUInt16BE(reply.length, 0);
				reply.copy(framed, 2);
				socket.write(framed);
			}
		});
	}

	function onLogLine(msg: Buffer): void {
		// Squid sends one name per line and nothing else (ADR 0038); "-" means no name.
		for (const line of msg.toString("latin1").split("\n")) {
			if (line.trim() === "-") continue;
			count(line, "tls");
		}
	}

	async function listen(): Promise<void> {
		const dnsPort = options.dnsPort ?? BLOCKED_DNS_PORT;
		const logPort = options.logPort ?? BLOCKED_LOG_PORT;
		udp = createSocket("udp4");
		udp.on("message", answerUdp);
		udp.on("error", (e) =>
			logger.warn({ error: e.message }, "blocked-name DNS socket error"),
		);
		await new Promise<void>((resolve, reject) => {
			udp?.once("error", reject);
			udp?.bind(dnsPort, "127.0.0.1", () => resolve());
		});
		tcp = createServer(answerTcp);
		await new Promise<void>((resolve, reject) => {
			tcp?.once("error", reject);
			tcp?.listen(dnsPort, "127.0.0.1", () => resolve());
		});
		log = createSocket("udp4");
		log.on("message", onLogLine);
		log.on("error", (e) =>
			logger.warn({ error: e.message }, "blocked-name log socket error"),
		);
		await new Promise<void>((resolve, reject) => {
			log?.once("error", reject);
			log?.bind(logPort, "127.0.0.1", () => resolve());
		});
	}

	function ports(): { dns: number; dnsTcp: number; log: number } {
		const t = tcp?.address();
		return {
			dns: udp?.address().port ?? 0,
			dnsTcp: typeof t === "object" && t ? t.port : 0,
			log: log?.address().port ?? 0,
		};
	}

	async function close(): Promise<void> {
		for (const s of sockets) s.destroy();
		await Promise.all([
			new Promise<void>((r) => (udp ? udp.close(() => r()) : r())),
			new Promise<void>((r) => (log ? log.close(() => r()) : r())),
			new Promise<void>((r) => (tcp ? tcp.close(() => r()) : r())),
		]);
	}

	return { count, flush, prune, ports, listen, close };
}

/** Listen, then flush every FLUSH_SECONDS and prune every PRUNE_HOURS. */
export async function startBlockedCounter(
	options: BlockedCounterOptions,
): Promise<BlockedCounter> {
	const counter = createBlockedCounter(options);
	const { logger } = options;
	await counter.listen();
	const flushTimer = setInterval(() => {
		counter
			.flush()
			.catch((e: Error) =>
				logger.warn({ error: e.message }, "blocked-name flush failed"),
			);
	}, FLUSH_SECONDS * 1000);
	flushTimer.unref();
	const prune = (): void => {
		counter
			.prune()
			.catch((e: Error) =>
				logger.warn({ error: e.message }, "blocked-name prune failed"),
			);
	};
	const pruneTimer = setInterval(prune, PRUNE_HOURS * 3_600_000);
	pruneTimer.unref();
	prune();
	return counter;
}
