import { afterEach, describe, expect, test, vi } from "vitest";
import { cursorAt, fakeSpawn, journalLine } from "./fake-journal.js";
import {
	JournalReader,
	journalArgs,
	LogsBusyError,
	LogsUnavailableError,
	MAX_CONCURRENT_READS,
	MAX_SCAN_ENTRIES,
	parseJournalLine,
	SCAN_TIMEOUT_MS,
} from "./journal.js";

afterEach(() => {
	vi.useRealTimers();
});

describe("journalArgs", () => {
	test("always names the three Portikus units and JSON output", () => {
		const args = journalArgs({ reverse: true });
		expect(args).toEqual([
			"--output=json",
			"--output-fields=MESSAGE,_SYSTEMD_UNIT,__REALTIME_TIMESTAMP",
			"--no-pager",
			"--unit=portikus-api.service",
			"--unit=portikus-worker.service",
			"--unit=portikus-controller.service",
			"--reverse",
		]);
	});

	test("dates become epoch seconds and levels a fixed pattern", () => {
		const args = journalArgs({
			reverse: false,
			since: new Date("2026-09-26T12:00:00.900Z"),
			until: new Date("2026-09-26T13:00:00Z"),
			afterCursor: cursorAt(10),
			levels: ["error", "warn"],
		});
		expect(args).toContain("--since=@1790424000");
		expect(args).toContain("--until=@1790427600");
		expect(args).toContain(`--after-cursor=${cursorAt(10)}`);
		expect(args).toContain('--grep="level":"(error|fatal|warn)"');
		expect(args).not.toContain("--reverse");
	});

	test("all four levels need no --grep", () => {
		const args = journalArgs({
			reverse: true,
			levels: ["error", "warn", "info", "debug"],
		});
		expect(args.some((arg) => arg.startsWith("--grep"))).toBe(false);
	});

	test("a malformed cursor never becomes an argument", () => {
		expect(() =>
			journalArgs({ reverse: true, afterCursor: "--unit=sshd.service" }),
		).toThrow();
	});
});

describe("parseJournalLine", () => {
	test("reads the cursor, time, service and message", () => {
		const entry = parseJournalLine(journalLine(1, "hello", "portikus-worker.service"));
		expect(entry).toEqual({
			cursor: cursorAt(1),
			at: new Date(Date.UTC(2026, 8, 26, 12, 0, 1)),
			service: "worker",
			message: "hello",
		});
	});

	test("decodes a MESSAGE sent as bytes", () => {
		const bytes = [...Buffer.from('{"level":"warn"}')];
		expect(parseJournalLine(journalLine(1, bytes))?.message).toBe('{"level":"warn"}');
	});

	test("refuses other units, bad cursors and truncated lines", () => {
		expect(parseJournalLine(journalLine(1, "x", "caddy.service"))).toBeNull();
		expect(
			parseJournalLine(journalLine(1, "x").replace(cursorAt(1), "bad")),
		).toBeNull();
		expect(parseJournalLine(journalLine(1, "x").slice(0, 30))).toBeNull();
		expect(parseJournalLine(journalLine(1, null))?.message).toBeNull();
	});
});

describe("JournalReader", () => {
	test("runs the configured path with an argument array and reads every entry", async () => {
		const { spawn, calls } = fakeSpawn();
		const reader = new JournalReader({ path: "/usr/bin/journalctl", spawn });
		const seen: string[] = [];
		const done = reader.read({ reverse: true }, (entry) => {
			seen.push(entry.message ?? "");
			return "continue";
		});
		calls[0]?.child.finish([
			journalLine(2, "b"),
			journalLine(1, "a"),
			'{"__CURSOR":"trunc',
		]);
		await expect(done).resolves.toEqual({ lastCursor: cursorAt(1), reason: "end" });
		expect(seen).toEqual(["b", "a"]);
		expect(calls[0]?.path).toBe("/usr/bin/journalctl");
	});

	test("stops and kills journalctl when the caller has enough", async () => {
		const { spawn, calls } = fakeSpawn();
		const reader = new JournalReader({ path: "j", spawn });
		const done = reader.read({ reverse: true }, () => "stop");
		calls[0]?.child.finish([journalLine(2, "b"), journalLine(1, "a")]);
		await expect(done).resolves.toEqual({ lastCursor: cursorAt(2), reason: "stopped" });
		expect(calls[0]?.child.killed).toBe("SIGKILL");
	});

	test(`stops at ${MAX_SCAN_ENTRIES} entries`, async () => {
		const { spawn, calls } = fakeSpawn();
		const reader = new JournalReader({ path: "j", spawn });
		let count = 0;
		const done = reader.read({ reverse: true }, () => {
			count++;
			return "continue";
		});
		const lines = Array.from({ length: MAX_SCAN_ENTRIES + 50 }, (_, i) =>
			journalLine(i, "m"),
		);
		calls[0]?.child.finish(lines);
		const result = await done;
		expect(result.reason).toBe("limit");
		expect(count).toBe(MAX_SCAN_ENTRIES);
		expect(calls[0]?.child.killed).toBe("SIGKILL");
	});

	test(`stops after ${SCAN_TIMEOUT_MS} ms`, async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const { spawn, calls } = fakeSpawn();
		const reader = new JournalReader({ path: "j", spawn });
		const done = reader.read({ reverse: true }, () => "continue");
		calls[0]?.child.stdout.write(`${journalLine(1, "a")}\n`);
		await vi.advanceTimersByTimeAsync(SCAN_TIMEOUT_MS);
		await expect(done).resolves.toEqual({ lastCursor: cursorAt(1), reason: "limit" });
		expect(calls[0]?.child.killed).toBe("SIGKILL");
	});

	test(`a read beyond ${MAX_CONCURRENT_READS} at once is refused as busy`, async () => {
		const { spawn, calls } = fakeSpawn();
		const reader = new JournalReader({ path: "j", spawn });
		const first = reader.read({ reverse: true }, () => "continue");
		const second = reader.read({ reverse: true }, () => "continue");
		await expect(
			reader.read({ reverse: true }, () => "continue"),
		).rejects.toBeInstanceOf(LogsBusyError);
		expect(calls).toHaveLength(2);
		calls[0]?.child.finish([]);
		calls[1]?.child.finish([]);
		await first;
		await second;
		// A slot is free again once a process has exited.
		const third = reader.read({ reverse: true }, () => "continue");
		calls[2]?.child.finish([]);
		await expect(third).resolves.toEqual({ lastCursor: null, reason: "end" });
	});

	test("a missing journalctl is unavailable", async () => {
		const reader = new JournalReader({ path: "/nonexistent/journalctl" });
		await expect(
			reader.read({ reverse: true }, () => "continue"),
		).rejects.toBeInstanceOf(LogsUnavailableError);
	});

	test("a non-zero exit is unavailable", async () => {
		const { spawn, calls } = fakeSpawn();
		const reader = new JournalReader({ path: "j", spawn });
		const done = reader.read({ reverse: true }, () => "continue");
		calls[0]?.child.finish([], 1, "Failed to open journal\n");
		await expect(done).rejects.toBeInstanceOf(LogsUnavailableError);
	});

	test("a refused permission is unavailable even with exit 0", async () => {
		const { spawn, calls } = fakeSpawn();
		const reader = new JournalReader({ path: "j", spawn });
		const done = reader.read({ reverse: true }, () => "continue");
		calls[0]?.child.finish(
			[],
			0,
			"No journal files were opened due to insufficient permissions.\n",
		);
		await expect(done).rejects.toBeInstanceOf(LogsUnavailableError);
	});

	test("exit 1 with no output is --grep finding nothing", async () => {
		const { spawn, calls } = fakeSpawn();
		const reader = new JournalReader({ path: "j", spawn });
		const done = reader.read({ reverse: true, levels: ["error"] }, () => "continue");
		calls[0]?.child.finish([], 1);
		await expect(done).resolves.toEqual({ lastCursor: null, reason: "end" });
	});
});
