import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
		// journalctl refuses --since with a cursor; --until stays.
		expect(args.some((arg) => arg.startsWith("--since"))).toBe(false);
		expect(args).toContain("--until=@1790427600");
		expect(args).toContain(`--after-cursor=${cursorAt(10)}`);
		expect(args).toContain('--grep="level":"(error|fatal|warn)"');
		expect(args).not.toContain("--reverse");
	});

	test("without a cursor, --since is passed", () => {
		const args = journalArgs({
			reverse: true,
			since: new Date("2026-09-26T12:00:00.900Z"),
		});
		expect(args).toContain("--since=@1790424000");
	});

	test("--until rounds up so a slice ending mid-second keeps its last lines", () => {
		const args = journalArgs({
			reverse: true,
			since: new Date("2026-09-26T12:00:07.499Z"),
			until: new Date("2026-09-26T12:00:07.499Z"),
		});
		expect(args).toContain("--since=@1790424007");
		expect(args).toContain("--until=@1790424008");
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

	test("the time cap frees the slot even when the killed process never exits", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const { spawn, calls } = fakeSpawn();
		const reader = new JournalReader({ path: "j", spawn, maxConcurrent: 1 });
		const done = reader.read({ reverse: true }, () => "continue");
		if (calls[0]) calls[0].child.stuck = true;
		await vi.advanceTimersByTimeAsync(SCAN_TIMEOUT_MS);
		await expect(done).resolves.toEqual({ lastCursor: null, reason: "limit" });
		const next = reader.read({ reverse: true }, () => "continue");
		calls[1]?.child.finish([]);
		await expect(next).resolves.toEqual({ lastCursor: null, reason: "end" });
	});

	test("journalctl starts with only PATH and LANG in its environment", async () => {
		const dir = mkdtempSync(join(tmpdir(), "journal-env-"));
		const script = join(dir, "journalctl");
		const out = join(dir, "env.txt");
		writeFileSync(script, `#!/bin/sh\nenv > ${out}\n`);
		chmodSync(script, 0o755);
		process.env.PORTIKUS_TEST_SECRET = "hunter2";
		try {
			await new JournalReader({ path: script }).read(
				{ reverse: true },
				() => "continue",
			);
		} finally {
			delete process.env.PORTIKUS_TEST_SECRET;
		}
		const names = readFileSync(out, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => line.split("=")[0])
			.filter((name) => name !== "PWD" && name !== "SHLVL" && name !== "_");
		expect(names.sort()).toEqual(["LANG", "PATH"]);
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
		calls[0]?.child.finish([], 1, `  Failed to open journal\nsecond line\n`);
		await expect(done).rejects.toThrow(
			new LogsUnavailableError("journalctl exited 1: Failed to open journal"),
		);
	});

	test("journalctl's error text is capped at 200 characters", async () => {
		const { spawn, calls } = fakeSpawn();
		const reader = new JournalReader({ path: "j", spawn });
		const done = reader.read({ reverse: true }, () => "continue");
		calls[0]?.child.finish([], 1, "x".repeat(500));
		await expect(done).rejects.toThrow(`journalctl exited 1: ${"x".repeat(200)}`);
		await done.catch((error: Error) => expect(error.message).toHaveLength(221));
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
