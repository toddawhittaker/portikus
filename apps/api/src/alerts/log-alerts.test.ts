import type { Database, Notice } from "@portikus/db";
import { collectingLogger } from "@portikus/observability/testing";
import type { Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import { type JournalEntry, LogsBusyError, parseJournalLine } from "../logs/journal.js";
import { KERNEL_ALERT_REASONS, KERNEL_LINE_PATTERN } from "../logs/kernel.js";
import {
	classifyEntry,
	createLogAlerts,
	ERROR_SPIKE_THRESHOLD,
	type LogAlertReader,
	startLogAlerts,
} from "./log-alerts.js";

const T0 = new Date("2026-10-06T12:00:00Z");
let seq = 0;

function journalLine(fields: Record<string, unknown>, at: Date): string {
	seq++;
	return JSON.stringify({
		__CURSOR: `s=${"a".repeat(32)};i=${seq.toString(16)};b=${"b".repeat(32)};m=1;t=1;x=1`,
		__REALTIME_TIMESTAMP: String(at.getTime() * 1000),
		...fields,
	});
}

function kernel(prefix: string, src: string, at: Date): JournalEntry {
	const entry = parseJournalLine(
		journalLine(
			{
				_TRANSPORT: "kernel",
				MESSAGE: `${prefix}IN=br0 SRC=${src} DST=1.2.3.4 DPT=25`,
			},
			at,
		),
	);
	if (!entry) throw new Error("kernel line did not parse");
	return entry;
}

function apiError(
	at: Date,
	msg = "user bob@example.edu /home/bob/secret.ts failed",
): JournalEntry {
	const entry = parseJournalLine(
		journalLine(
			{
				_SYSTEMD_UNIT: "portikus-worker.service",
				MESSAGE: JSON.stringify({ level: "error", msg }),
			},
			at,
		),
	);
	if (!entry) throw new Error("unit line did not parse");
	return entry;
}

class FakeReader implements LogAlertReader {
	batches: JournalEntry[][] = [];
	requests: unknown[] = [];
	fail: Error | null = null;
	async read(request: unknown, onEntry: (e: JournalEntry) => "continue" | "stop") {
		this.requests.push(request);
		if (this.fail) throw this.fail;
		const batch = this.batches.shift() ?? [];
		for (const e of batch) onEntry(e);
		return { lastCursor: batch.at(-1)?.cursor ?? null, reason: "end" as const };
	}
}

function setup() {
	const reader = new FakeReader();
	const notices: Notice[] = [];
	let clock = T0;
	const tick = createLogAlerts({
		db: {} as Kysely<Database>,
		logger: collectingLogger().logger,
		reader,
		now: () => clock,
		instanceAt: async (address) => (address === "10.0.0.5" ? "ws-0a1b2c" : null),
		notify: async (n) => {
			notices.push(n);
		},
	});
	return {
		reader,
		notices,
		tick,
		advance(ms: number) {
			clock = new Date(clock.getTime() + ms);
			return clock;
		},
	};
}

describe("classifyEntry", () => {
	it("reads the code and address of an outbound-limit line", () => {
		expect(classifyEntry(kernel("portikus-ws-mail-blocked: ", "10.0.0.5", T0))).toEqual(
			{
				kind: "limit",
				code: "WORKSPACE_MAIL_BLOCKED",
				address: "10.0.0.5",
				at: T0,
			},
		);
	});

	it("alerts on every kernel line the log reader keeps", () => {
		const prefixes = KERNEL_LINE_PATTERN.slice(2, -1).split("|");
		expect(prefixes.length).toBeGreaterThan(0);
		for (const prefix of prefixes) {
			const parsed = classifyEntry(kernel(prefix, "10.0.0.5", T0));
			expect(parsed?.kind, prefix).toBe("limit");
			const code = parsed?.kind === "limit" ? parsed.code : "";
			expect(KERNEL_ALERT_REASONS[code], prefix).toBeTruthy();
		}
	});

	it("counts error and fatal lines and ignores warnings", () => {
		expect(classifyEntry(apiError(T0))?.kind).toBe("error");
		const warn = parseJournalLine(
			journalLine(
				{ _SYSTEMD_UNIT: "portikus-api.service", MESSAGE: '{"level":"warn"}' },
				T0,
			),
		);
		expect(warn && classifyEntry(warn)).toBeNull();
	});

	it("ignores a unit line that is not JSON", () => {
		expect(
			classifyEntry({ cursor: "c", at: T0, service: "api", message: "oops" }),
		).toBeNull();
	});
});

describe("outbound-limit alerts", () => {
	it("names the instance, never an email, once per workspace and reason an hour", async () => {
		const s = setup();
		s.reader.batches.push([
			kernel("portikus-ws-mail-blocked: ", "10.0.0.5", T0),
			kernel("portikus-ws-mail-blocked: ", "10.0.0.5", T0),
			kernel("portikus-ws-conn-limit: ", "10.0.0.5", T0),
		]);
		await s.tick();
		expect(s.notices.map((n) => n.title)).toEqual([
			"Workspace ws-0a1b2c was blocked from sending mail (port 25)",
			"Workspace ws-0a1b2c hit the new-connection limit",
		]);
		expect(JSON.stringify(s.notices)).not.toContain("@");

		s.advance(59 * 60_000);
		s.reader.batches.push([kernel("portikus-ws-mail-blocked: ", "10.0.0.5", T0)]);
		await s.tick();
		expect(s.notices).toHaveLength(2);

		s.advance(60_000);
		s.reader.batches.push([kernel("portikus-ws-mail-blocked: ", "10.0.0.5", T0)]);
		await s.tick();
		expect(s.notices).toHaveLength(3);
	});

	it("skips an address no workspace holds", async () => {
		const s = setup();
		s.reader.batches.push([kernel("portikus-ws-packet-limit: ", "10.0.0.9", T0)]);
		await s.tick();
		expect(s.notices).toEqual([]);
	});
});

describe("error spike", () => {
	it("raises once at the threshold with fixed text, then again only after it clears", async () => {
		const s = setup();
		s.reader.batches.push(
			Array.from({ length: ERROR_SPIKE_THRESHOLD - 1 }, () => apiError(T0)),
		);
		await s.tick();
		expect(s.notices).toEqual([]);

		s.reader.batches.push([apiError(s.advance(60_000))]);
		await s.tick();
		expect(s.notices).toEqual([
			{
				tone: "warning",
				title: `${ERROR_SPIKE_THRESHOLD} errors in the last 15 minutes`,
				body: "From portikus-worker. Open Admin, then Logs, and show errors to read them.",
			},
		]);
		const text = JSON.stringify(s.notices);
		expect(text).not.toContain("bob");
		expect(text).not.toContain("secret");

		s.reader.batches.push([apiError(s.advance(60_000))]);
		await s.tick();
		expect(s.notices).toHaveLength(1);

		// The first 19 leave the 15-minute window: the spike clears.
		s.advance(14 * 60_000);
		await s.tick();
		s.reader.batches.push(
			Array.from({ length: ERROR_SPIKE_THRESHOLD }, () => apiError(s.advance(1))),
		);
		await s.tick();
		expect(s.notices).toHaveLength(2);
	});
});

describe("reading", () => {
	it("starts at now, then continues from the last cursor", async () => {
		const s = setup();
		const e = apiError(T0);
		s.reader.batches.push([e]);
		await s.tick();
		await s.tick();
		expect(s.reader.requests).toEqual([
			{ reverse: false, levels: ["error", "warn"], since: T0 },
			{ reverse: false, levels: ["error", "warn"], afterCursor: e.cursor },
		]);
	});

	it("skips the tick when the journal is busy", async () => {
		const s = setup();
		s.reader.fail = new LogsBusyError();
		await expect(s.tick()).resolves.toBeUndefined();
		expect(s.notices).toEqual([]);
	});

	it("stop waits for a tick in flight and runs no more", async () => {
		let release: () => void = () => {};
		let reads = 0;
		const reader: LogAlertReader = {
			read: () => {
				reads++;
				return new Promise((resolve) => {
					release = () => resolve({ lastCursor: null, reason: "end" });
				});
			},
		};
		const stop = startLogAlerts({
			db: {} as Kysely<Database>,
			logger: collectingLogger().logger,
			reader,
			notify: async () => {},
		});
		let stopped = false;
		const done = stop().then(() => {
			stopped = true;
		});
		await Promise.resolve();
		expect(stopped).toBe(false);
		release();
		await done;
		expect(stopped).toBe(true);
		expect(reads).toBe(1);
	});
});
