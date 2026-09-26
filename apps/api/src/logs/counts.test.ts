import { expect, test } from "vitest";
import { LogCounter } from "./counts.js";
import { cursorAt, fakeSpawn, journalLine } from "./fake-journal.js";
import { JournalReader } from "./journal.js";

const NOW = new Date("2026-09-26T12:30:30.000Z");

function line(i: number, level: string, at: string): string {
	const message = JSON.stringify({ level, service: "api", time: at, msg: "m" });
	return journalLine(i, message, "portikus-api.service", Date.parse(at));
}

/** A counter whose journalctl answers each call with the next script entry. */
function counterWith(script: { lines: string[]; code?: number; limit?: boolean }[]) {
	const { spawn, calls } = fakeSpawn();
	const scripted = (path: string, args: readonly string[]) => {
		const child = spawn(path, args);
		const next = script[calls.length - 1] ?? { lines: [] };
		child.finish(next.lines, next.code ?? 0);
		return child;
	};
	const reader = new JournalReader({ path: "j", spawn: scripted, maxEntries: 3 });
	return { counter: new LogCounter(reader, () => NOW), calls };
}

test("counts errors, fatals and warnings per minute and rebuckets per range", async () => {
	const { counter, calls } = counterWith([
		{
			lines: [
				line(1, "error", "2026-09-26T12:01:10.000Z"),
				line(2, "fatal", "2026-09-26T12:01:50.000Z"),
				line(3, "warn", "2026-09-26T12:14:00.000Z"),
			],
		},
		{ lines: [line(0, "info", "2026-09-20T00:00:00.000Z")] },
	]);
	const hour = await counter.counts("1h");
	expect(hour.bucketSeconds).toBe(60);
	expect(hour.to).toBe("2026-09-26T12:31:00.000Z");
	expect(hour.from).toBe("2026-09-26T11:31:00.000Z");
	expect(hour.buckets).toEqual([
		{ at: "2026-09-26T12:01:00.000Z", errors: 2, warnings: 0 },
		{ at: "2026-09-26T12:14:00.000Z", errors: 0, warnings: 1 },
	]);
	expect(hour.oldestAt).toBe("2026-09-20T00:00:00.000Z");
	// The first read covers the 7-day window, errors and warnings only.
	expect(calls[0]?.args).toContain(
		`--since=@${Math.floor(NOW.getTime() / 1000) - 7 * 86400}`,
	);
	expect(calls[0]?.args).toContain('--grep="level":"(error|fatal|warn)"');

	const day = await counter.counts("1d");
	expect(day.bucketSeconds).toBe(900);
	expect(day.buckets).toEqual([
		{ at: "2026-09-26T12:00:00.000Z", errors: 2, warnings: 1 },
	]);
});

test("later reads continue from the last cursor", async () => {
	const { counter, calls } = counterWith([
		{ lines: [line(1, "warn", "2026-09-26T12:00:00.000Z")] },
		{ lines: [] },
		{ lines: [line(2, "warn", "2026-09-26T12:00:20.000Z")] },
		{ lines: [] },
	]);
	await counter.counts("1h");
	const second = await counter.counts("1h");
	expect(calls[2]?.args).toContain(`--after-cursor=${cursorAt(1)}`);
	expect(calls[2]?.args.some((arg) => arg.startsWith("--since"))).toBe(false);
	expect(second.buckets).toEqual([
		{ at: "2026-09-26T12:00:00.000Z", errors: 0, warnings: 2 },
	]);
});

test("complete stays false until a read reaches the end", async () => {
	const many = Array.from({ length: 5 }, (_, i) =>
		line(i + 1, "error", "2026-09-26T12:00:00.000Z"),
	);
	const { counter } = counterWith([
		{ lines: many },
		{ lines: [] },
		{ lines: many.slice(3) },
		{ lines: [] },
	]);
	const first = await counter.counts("1h");
	expect(first.complete).toBe(false);
	expect(first.buckets[0]?.errors).toBe(3);
	const second = await counter.counts("1h");
	expect(second.complete).toBe(true);
	expect(second.buckets[0]?.errors).toBe(5);
});

test("when every journalctl slot is taken it answers from memory", async () => {
	const { spawn, calls } = fakeSpawn();
	const reader = new JournalReader({ path: "j", spawn, maxConcurrent: 0 });
	const counts = await new LogCounter(reader, () => NOW).counts("7d");
	expect(calls).toHaveLength(0);
	expect(counts).toMatchObject({ bucketSeconds: 3600, buckets: [], complete: false });
});
