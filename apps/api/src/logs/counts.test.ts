import { expect, test, vi } from "vitest";
import { type FakeChild, fakeSpawn, journalLine } from "../testing/fake-journal.js";
import { LogCounter } from "./counts.js";
import { JournalReader } from "./journal.js";
import { KERNEL_LINE_PATTERN } from "./kernel.js";

const NOW = new Date("2026-09-26T12:30:30.000Z");
const at = (iso: string) => `@${Math.floor(Date.parse(iso) / 1000)}`;

function line(i: number, level: string, when: string): string {
	const message = JSON.stringify({ level, service: "api", time: when, msg: "m" });
	return journalLine(i, message, "portikus-api.service", Date.parse(when));
}

type Answer = (args: readonly string[], child: FakeChild) => void;

/** A counter whose journalctl calls `answer` with each argument list. */
function counterWith(
	answer: Answer,
	options: { maxEntries?: number; timeoutMs?: number } = {},
) {
	const { spawn, calls } = fakeSpawn();
	const scripted = (path: string, args: readonly string[]) => {
		const child = spawn(path, args);
		answer(args, child);
		return child;
	};
	const reader = new JournalReader({ path: "j", spawn: scripted, ...options });
	let clock = 0;
	const counter = new LogCounter(
		reader,
		() => NOW,
		() => clock,
	);
	return { counter, calls, advanceClock: (ms: number) => (clock += ms) };
}

const isOldestLookup = (args: readonly string[]) =>
	!args.some((a) => a.startsWith("--grep"));
const sinceOf = (args: readonly string[]) => args.find((a) => a.startsWith("--since="));

test("counts errors, fatals and warnings per minute and rebuckets per range", async () => {
	const { counter } = counterWith((args, child) => {
		if (isOldestLookup(args))
			child.finish([line(0, "info", "2026-09-20T00:00:00.000Z")]);
		else if (
			sinceOf(args) === `--since=${at("2026-09-26T11:30:00Z")}` &&
			!args.includes("--reverse")
		) {
			child.finish([
				line(1, "error", "2026-09-26T12:01:10.000Z"),
				line(2, "fatal", "2026-09-26T12:01:50.000Z"),
				line(3, "warn", "2026-09-26T12:14:00.000Z"),
			]);
		} else child.finish([]);
	});
	const hour = await counter.counts("1h");
	expect(hour.bucketSeconds).toBe(60);
	expect(hour.to).toBe("2026-09-26T12:31:00.000Z");
	expect(hour.from).toBe("2026-09-26T11:31:00.000Z");
	expect(hour.buckets).toEqual([
		{ at: "2026-09-26T12:01:00.000Z", errors: 2, warnings: 0 },
		{ at: "2026-09-26T12:14:00.000Z", errors: 0, warnings: 1 },
	]);
	expect(hour.oldestAt).toBe("2026-09-20T00:00:00.000Z");

	const day = await counter.counts("1d");
	expect(day.bucketSeconds).toBe(900);
	expect(day.buckets).toEqual([
		{ at: "2026-09-26T12:00:00.000Z", errors: 2, warnings: 1 },
	]);
});

test("the last hour is counted first, then older days newest first", async () => {
	const { counter, calls } = counterWith((_args, child) => child.finish([]));
	const counts = await counter.counts("1h");
	const grepCalls = calls.filter((c) => !isOldestLookup(c.args));
	expect(grepCalls[0]?.args).toContain(`--since=${at("2026-09-26T11:30:00Z")}`);
	expect(grepCalls[0]?.args).toContain(`--until=${at("2026-09-26T12:30:30Z")}`);
	expect(grepCalls[0]?.args).toContain(
		`--grep="level":"(error|fatal|warn)"|${KERNEL_LINE_PATTERN}`,
	);
	expect(grepCalls[0]?.args).not.toContain("--reverse");
	expect(grepCalls[1]?.args).toContain("--reverse");
	expect(grepCalls[1]?.args).toContain(`--since=${at("2026-09-25T11:30:00Z")}`);
	expect(grepCalls[1]?.args).toContain(`--until=${at("2026-09-26T11:30:00Z")}`);
	// One hour and seven days reach back past the window's start.
	expect(grepCalls).toHaveLength(8);
	expect(counts.complete).toBe(true);
});

test("a slice that times out with nothing printed is narrowed, then passed over", async () => {
	// Debug lines that --grep scans without a match: journalctl prints nothing
	// until the time cap. The count must still move on.
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setImmediate"] });
	try {
		// Any backward read covering 11:00 on the 26th never answers.
		const stuck = Date.parse("2026-09-26T11:00:00Z") / 1000;
		const secondsOf = (args: readonly string[], name: string) =>
			Number(args.find((a) => a.startsWith(name))?.slice(name.length + 1));
		const { counter, calls } = counterWith(
			(args, child) => {
				const since = secondsOf(args, "--since=");
				const until = secondsOf(args, "--until=");
				if (args.includes("--reverse") && since <= stuck && stuck < until) return;
				child.finish([]);
			},
			{ timeoutMs: 10 },
		);
		const pending = counter.counts("1h");
		await vi.runAllTimersAsync();
		const first = await pending;
		expect(first.complete).toBe(false);
		const again = counter.counts("1h");
		await vi.runAllTimersAsync();
		await again;
		const sinces = calls
			.filter((c) => !isOldestLookup(c.args))
			.map((c) => sinceOf(c.args));
		// The day gave nothing, so its last hour was tried alone once, then passed over.
		expect(sinces.slice(1, 4)).toEqual([
			`--since=${at("2026-09-25T11:30:00Z")}`,
			`--since=${at("2026-09-26T10:30:00Z")}`,
			`--since=${at("2026-09-26T09:30:00Z")}`,
		]);
		// No slice is ever read twice.
		const slices = calls
			.filter((c) => !isOldestLookup(c.args))
			.map((c) => `${sinceOf(c.args)} ${c.args.find((a) => a.startsWith("--until="))}`);
		expect(new Set(slices).size).toBe(slices.length);
	} finally {
		vi.useRealTimers();
	}
});

test("a slice that hits the entry cap resumes from the last entry read", async () => {
	const lines = [1, 2, 3, 4, 5].map((i) =>
		line(i, i % 2 ? "error" : "info", `2026-09-26T12:0${i}:00.000Z`),
	);
	const { counter, calls } = counterWith(
		(args, child) => {
			const since = sinceOf(args);
			if (since === `--since=${at("2026-09-26T11:30:00Z")}`)
				child.finish(lines.slice(0, 3));
			else if (
				since === `--since=${at("2026-09-26T12:03:00Z")}` &&
				!args.includes("--reverse")
			) {
				child.finish([lines[2] as string, lines[4] as string]);
			} else child.finish([]);
		},
		{ maxEntries: 3 },
	);
	await counter.counts("1h");
	// The first read stopped at 12:03, so it kept only 12:01; the second read
	// started at 12:03 and counted 12:03 and 12:05.
	const second = await counter.counts("1h");
	expect(
		calls.some((c) => sinceOf(c.args) === `--since=${at("2026-09-26T12:03:00Z")}`),
	).toBe(true);
	expect(second.buckets.map((b) => [b.at, b.errors])).toEqual([
		["2026-09-26T12:01:00.000Z", 1],
		["2026-09-26T12:03:00.000Z", 1],
		["2026-09-26T12:05:00.000Z", 1],
	]);
});

test("complete once the whole 7 days are counted", async () => {
	const { counter } = counterWith((_args, child) => child.finish([]));
	let last = await counter.counts("7d");
	for (let i = 0; i < 10 && !last.complete; i++) last = await counter.counts("7d");
	expect(last.complete).toBe(true);
});

test("each request stops starting slices after its time budget", async () => {
	const { counter, calls, advanceClock } = counterWith((_args, child) => {
		advanceClock(3000);
		child.finish([]);
	});
	await counter.counts("1h");
	expect(calls.filter((c) => !isOldestLookup(c.args))).toHaveLength(2);
});

test("the oldest-entry lookup runs at most once an hour", async () => {
	const { counter, calls, advanceClock } = counterWith((_args, child) =>
		child.finish([]),
	);
	await counter.counts("1h");
	await counter.counts("1h");
	expect(calls.filter((c) => isOldestLookup(c.args))).toHaveLength(1);
	advanceClock(3_600_000);
	await counter.counts("1h");
	expect(calls.filter((c) => isOldestLookup(c.args))).toHaveLength(2);
});

test("when every journalctl slot is taken it answers from memory", async () => {
	const { spawn, calls } = fakeSpawn();
	const reader = new JournalReader({ path: "j", spawn, maxConcurrent: 0 });
	const counts = await new LogCounter(reader, () => NOW).counts("7d");
	expect(calls).toHaveLength(0);
	expect(counts).toMatchObject({ bucketSeconds: 3600, buckets: [], complete: false });
});
