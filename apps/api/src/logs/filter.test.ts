import { LogQuery } from "@portikus/contracts";
import { describe, expect, test } from "vitest";
import { cursorAt, fakeSpawn, journalLine } from "./fake-journal.js";
import { levelOf, matchesLine, parsePortikusLine, readLogPage } from "./filter.js";
import { JournalReader } from "./journal.js";

const USER = "00000000-0000-4000-8000-00000000000a";
const WS = "00000000-0000-4000-8000-00000000000b";

function msg(fields: Record<string, unknown>): string {
	return JSON.stringify({
		level: "warn",
		service: "api",
		time: "2026-09-26T12:00:00.000Z",
		...fields,
	});
}

/** Run one page read over `lines` (newest first) and return it with journalctl's argv. */
async function page(
	query: Record<string, string>,
	lines: string[],
	instance: string | null = null,
) {
	const { spawn, calls } = fakeSpawn();
	const reader = new JournalReader({ path: "j", spawn });
	const done = readLogPage(reader, LogQuery.parse(query), instance);
	calls[0]?.child.finish(lines);
	return { result: await done, args: calls[0]?.args ?? [] };
}

describe("parsePortikusLine", () => {
	test("keeps only JSON objects with string level, service and time", () => {
		expect(parsePortikusLine(msg({ msg: "x" }))?.msg).toBe("x");
		expect(parsePortikusLine("Started Portikus API.")).toBeNull();
		expect(parsePortikusLine("    at Object.<anonymous> (index.js:1:1)")).toBeNull();
		expect(parsePortikusLine('["level"]')).toBeNull();
		expect(parsePortikusLine('{"level":40,"service":"api","time":"t"}')).toBeNull();
		expect(parsePortikusLine('{"level":"warn","time":"t"}')).toBeNull();
		expect(parsePortikusLine(null)).toBeNull();
	});

	test("fatal counts as error", () => {
		expect(levelOf("fatal")).toBe("error");
		expect(levelOf("nonsense")).toBeNull();
	});
});

describe("matchesLine", () => {
	const line = parsePortikusLine(
		msg({
			code: "TERMINAL_LIMIT",
			msg: "Too Many Terminals",
			userId: USER,
			workspaceId: WS,
		}),
	);
	if (!line) throw new Error("fixture");
	const base = { levels: ["error", "warn"] as const };

	test("levels and services", () => {
		expect(matchesLine(line, "api", { ...base })).toBe(true);
		expect(matchesLine(line, "api", { levels: ["info"] })).toBe(false);
		expect(matchesLine(line, "api", { ...base, services: ["worker"] })).toBe(false);
	});

	test("text is a case-insensitive substring of code, msg or error", () => {
		expect(matchesLine(line, "api", { ...base, text: "many terminals" })).toBe(true);
		expect(matchesLine(line, "api", { ...base, text: "terminal_limit" })).toBe(true);
		expect(matchesLine(line, "api", { ...base, text: "api" })).toBe(false);
		const withError = parsePortikusLine(msg({ error: { message: "Disk Full" } }));
		if (!withError) throw new Error("fixture");
		expect(matchesLine(withError, "api", { ...base, text: "disk full" })).toBe(true);
	});

	test("user and workspace", () => {
		expect(matchesLine(line, "api", { ...base, userId: USER })).toBe(true);
		expect(matchesLine(line, "api", { ...base, userId: WS })).toBe(false);
		expect(matchesLine(line, "api", { ...base, workspaceId: WS })).toBe(true);
	});

	test("the controller's instance field matches the workspace's instance", () => {
		const ctl = parsePortikusLine(
			msg({ service: "workspace-controller", instance: "ws-abc" }),
		);
		if (!ctl) throw new Error("fixture");
		const filter = { ...base, workspaceId: WS, instanceName: "ws-abc" };
		expect(matchesLine(ctl, "controller", filter)).toBe(true);
		expect(matchesLine(ctl, "api", filter)).toBe(false);
		expect(matchesLine(ctl, "controller", { ...filter, instanceName: null })).toBe(
			false,
		);
	});
});

describe("readLogPage", () => {
	test("skips and counts non-Portikus lines, redacts the rest", async () => {
		const { result } = await page({}, [
			journalLine(
				3,
				msg({ msg: "kept", token: "secret-token", nested: { cookie: "c=1" } }),
			),
			journalLine(2, "Started Portikus API."),
			journalLine(1, msg({ level: "info", msg: "info is off by default" })),
		]);
		expect(result.skippedLines).toBe(1);
		expect(result.lines).toHaveLength(1);
		expect(result.lines[0]?.line.token).toBe("[redacted]");
		expect(JSON.stringify(result.lines)).not.toContain("secret-token");
		expect(JSON.stringify(result.lines)).not.toContain("c=1");
		expect(result.nextCursor).toBeNull();
		expect(result.scanComplete).toBe(true);
	});

	test("a text filter cannot find a redacted value", async () => {
		const { result } = await page({ q: "secret-token" }, [
			journalLine(1, msg({ msg: "m", token: "secret-token" })),
		]);
		expect(result.lines).toHaveLength(0);
	});

	test("a full page stops at 100 lines with a cursor to continue", async () => {
		const lines = Array.from({ length: 150 }, (_, i) =>
			journalLine(150 - i, msg({ msg: `m${i}` })),
		);
		const { result } = await page({}, lines);
		expect(result.lines).toHaveLength(100);
		expect(result.nextCursor).toBe(cursorAt(51));
		expect(result.scanComplete).toBe(true);
	});

	test("the cursor pages on from where the last page stopped", async () => {
		const { args } = await page({ cursor: cursorAt(51) }, []);
		expect(args).toContain(`--after-cursor=${cursorAt(51)}`);
		expect(args).toContain("--reverse");
	});

	test("no argument ever contains request text", async () => {
		const q = "needle'; rm -rf / --unit=sshd.service";
		const { args } = await page(
			{ q, user: USER, workspace: WS, level: "warn", service: "api" },
			[],
			"ws-instance",
		);
		for (const arg of args) {
			expect(arg).not.toContain("needle");
			expect(arg).not.toContain(USER);
			expect(arg).not.toContain(WS);
			expect(arg).not.toContain("ws-instance");
			expect(arg).not.toContain("sshd");
		}
		expect(args).toContain('--grep="level":"(warn)"');
	});
});
