/**
 * Codex plan limits through `codex app-server` (SPEC.md §10.8): a fake
 * `codex` on PATH speaks the protocol seen from Codex 0.162.1.
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { AgentLimits } from "./agent-limits-route.js";
import {
	CODEX_READ_INTERVAL_MS,
	CodexLimits,
	parseCodexRateLimits,
	readCodexLimitsOnce,
	windowLabel,
} from "./codex-limits.js";
import { CodingAgentBoard } from "./coding-agent-status.js";

const FAKE = `#!${process.execPath}
const fs = require("node:fs");
const mode = process.env.FAKE_CODEX_MODE;
const log = process.env.FAKE_CODEX_LOG;
fs.writeFileSync(process.env.FAKE_CODEX_PID, String(process.pid));
const now = Math.floor(Date.now() / 1000);
const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
let buf = "";
process.stdin.on("data", (chunk) => {
	buf += chunk;
	let i;
	while ((i = buf.indexOf("\\n")) >= 0) {
		const msg = JSON.parse(buf.slice(0, i));
		buf = buf.slice(i + 1);
		fs.appendFileSync(log, msg.method + "\\n");
		if (msg.method === "initialize") out({ id: 1, result: { userAgent: "x", codexHome: "/home/s/.codex" } });
		if (msg.method !== "account/rateLimits/read") continue;
		process.stderr.write("warning on stderr\\n");
		out({ method: "configWarning", params: { message: "bubblewrap" } });
		out({ method: "remoteControl/status/changed", params: {} });
		out({ id: 3, result: { rateLimits: null } });
		process.stdout.write("not json\\n");
		if (mode === "hang") continue;
		if (mode === "error") { out({ id: 2, error: { code: -32603, message: "failed to fetch" } }); continue; }
		const primary = { usedPercent: 12, windowDurationMins: 300, resetsAt: now + 3600 };
		const secondary = { usedPercent: 40, windowDurationMins: 10080, resetsAt: now + 86400 };
		out({ id: 2, result: { accountId: "acct", ordinaryUsageAllowed: true, rateLimits: {
			limitId: "codex", planType: "plus",
			primary: mode === "null-windows" ? null : primary,
			secondary: mode === "null-windows" || mode === "primary-only" ? null : secondary,
		} } });
	}
});
`;

let dir: string;
let log: string;
let pidFile: string;

function env(mode: string): NodeJS.ProcessEnv {
	return {
		...process.env,
		PATH: `${dir}:${process.env.PATH}`,
		FAKE_CODEX_MODE: mode,
		FAKE_CODEX_LOG: log,
		FAKE_CODEX_PID: pidFile,
	};
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function lastChildGone(): Promise<boolean> {
	const pid = Number(readFileSync(pidFile, "utf8"));
	await new Promise((r) => setTimeout(r, 100));
	return !alive(pid);
}

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "fake-codex-"));
	log = join(dir, "log");
	pidFile = join(dir, "pid");
	writeFileSync(join(dir, "codex"), FAKE);
	chmodSync(join(dir, "codex"), 0o755);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("readCodexLimitsOnce", () => {
	test("keeps the two windows' numbers, labelled, with ISO reset times", async () => {
		writeFileSync(log, "");
		const before = Math.floor(Date.now() / 1000);
		const limits = await readCodexLimitsOnce({ env: env("ok") });
		expect(limits?.windows.map((w) => [w.name, w.usedPercent])).toEqual([
			["5h", 12],
			["7d", 40],
		]);
		const reset = Date.parse(limits?.windows[0]?.resetsAt ?? "") / 1000;
		expect(reset).toBeGreaterThanOrEqual(before + 3600);
		expect(reset).toBeLessThanOrEqual(before + 3605);
		expect(Object.keys(limits ?? {}).sort()).toEqual(["observedAt", "windows"]);
		expect(JSON.stringify(limits)).not.toContain("acct");
		// Never `account/read`: only the handshake and the limits call.
		expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
			"initialize",
			"initialized",
			"account/rateLimits/read",
		]);
		expect(await lastChildGone()).toBe(true);
	});

	test("skips a null window and is null when both are", async () => {
		const one = await readCodexLimitsOnce({ env: env("primary-only") });
		expect(one?.windows.map((w) => w.name)).toEqual(["5h"]);
		expect(await readCodexLimitsOnce({ env: env("null-windows") })).toBeNull();
	});

	test("an error reply is null", async () => {
		expect(await readCodexLimitsOnce({ env: env("error") })).toBeNull();
	});

	test("a hang times out to null and the child is killed", async () => {
		const limits = await readCodexLimitsOnce({ env: env("hang"), timeoutMs: 500 });
		expect(limits).toBeNull();
		expect(await lastChildGone()).toBe(true);
	});

	test("a missing codex binary is null", async () => {
		const empty = mkdtempSync(join(tmpdir(), "no-codex-"));
		try {
			expect(
				await readCodexLimitsOnce({ env: { ...process.env, PATH: empty } }),
			).toBeNull();
		} finally {
			rmSync(empty, { recursive: true, force: true });
		}
	});
});

describe("parsing", () => {
	test("labels windows by length", () => {
		expect(windowLabel(300)).toBe("5h");
		expect(windowLabel(10080)).toBe("7d");
		expect(windowLabel(60)).toBe("1h");
		expect(windowLabel(1440)).toBe("1d");
		expect(windowLabel(43200)).toBe("30d");
	});

	test("rejects shapes outside the contract", () => {
		const now = new Date();
		const at = Math.floor(now.getTime() / 1000) + 60;
		const with_ = (primary: unknown) =>
			parseCodexRateLimits({ rateLimits: { primary } }, now);
		expect(parseCodexRateLimits(null, now)).toBeNull();
		expect(parseCodexRateLimits({ rateLimits: null }, now)).toBeNull();
		expect(
			with_({ usedPercent: 150, windowDurationMins: 300, resetsAt: at }),
		).toBeNull();
		expect(
			with_({ usedPercent: "1", windowDurationMins: 300, resetsAt: at }),
		).toBeNull();
		expect(with_({ usedPercent: 1, windowDurationMins: 0, resetsAt: at })).toBeNull();
	});
});

const SAMPLE: AgentLimits = { windows: [], observedAt: new Date().toISOString() };

describe("CodexLimits", () => {
	test("serves the cache at once, refreshes in the background, one reader at a time", async () => {
		let now = 0;
		let release: (value: AgentLimits | null) => void = () => {};
		let calls = 0;
		const limits = new CodexLimits({
			readOnce: () => {
				calls++;
				return new Promise((r) => {
					release = r;
				});
			},
			now: () => now,
		});
		expect(await limits.read()).toBeNull();
		now = CODEX_READ_INTERVAL_MS * 2;
		expect(await limits.read()).toBeNull();
		expect(calls).toBe(1);
		release(SAMPLE);
		await new Promise((r) => setImmediate(r));
		now = 0;
		expect(await limits.read()).toBe(SAMPLE);
		expect(calls).toBe(1);
		now = CODEX_READ_INTERVAL_MS - 1;
		await limits.read();
		expect(calls).toBe(1);
		now = CODEX_READ_INTERVAL_MS;
		expect(await limits.read()).toBe(SAMPLE);
		expect(calls).toBe(2);
	});

	test("a failed read leaves null", async () => {
		const limits = new CodexLimits({ readOnce: () => Promise.reject(new Error("x")) });
		await limits.refresh();
		expect(await limits.read()).toBeNull();
	});

	test("a Codex finished state triggers a read, within the cadence", async () => {
		let now = 0;
		let calls = 0;
		const limits = new CodexLimits({
			readOnce: async () => {
				calls++;
				return SAMPLE;
			},
			now: () => now,
		});
		const board = new CodingAgentBoard();
		limits.watch(board);
		board.set("t1", "claude", "finished", 1);
		board.set("t2", "codex", "working", 1);
		expect(calls).toBe(0);
		board.set("t2", "codex", "finished", 2);
		expect(calls).toBe(1);
		await new Promise((r) => setImmediate(r));
		board.set("t2", "codex", "working", 3);
		board.set("t2", "codex", "finished", 4);
		expect(calls).toBe(1);
		now = CODEX_READ_INTERVAL_MS;
		board.set("t2", "codex", "working", 5);
		board.set("t2", "codex", "finished", 6);
		expect(calls).toBe(2);
	});
});
