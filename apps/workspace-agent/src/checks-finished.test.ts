/**
 * Finished check runs the workspace agent holds for the control plane to
 * keep ("Check result metadata", SPEC.md §25): each carries its timing,
 * result, exit code and the tail of its output, and the hold is bounded.
 */
import {
	CHECK_HISTORY_PER_CHECK,
	FinishedCheckRunsResponse,
	MAX_HELD_FINISHED_RUNS,
	MAX_STORED_CHECK_OUTPUT_BYTES,
} from "@portikus/contracts";
import type { FastifyBaseLogger } from "fastify";
import { expect, test } from "vitest";
import { CheckRunner } from "./checks-route.js";

const quietLog = {
	error: () => {},
	warn: () => {},
	debug: () => {},
	info: () => {},
} as unknown as FastifyBaseLogger;

/** A runner whose PTYs the test ends by hand. */
function fakeRunner() {
	const ptys: {
		data: (text: string) => void;
		exit: (e: { exitCode: number; signal?: number }) => void;
	}[] = [];
	const spawn = () => {
		const pty = {
			pid: 0,
			data: (_: string) => {},
			exit: (_: { exitCode: number; signal?: number }) => {},
			onData(fn: (text: string) => void) {
				pty.data = fn;
			},
			onExit(fn: (e: { exitCode: number; signal?: number }) => void) {
				pty.exit = fn;
			},
			kill: () => {},
			pause: () => {},
			resume: () => {},
		};
		ptys.push(pty);
		return pty;
	};
	const runner = new CheckRunner(quietLog, spawn as never);
	function runOnce(slug: string, checkId: string, output: string, exitCode: number) {
		runner.start({
			slug,
			check: { id: checkId, name: checkId, command: "x" },
			cwd: "/",
		});
		const pty = ptys.at(-1);
		pty?.data(output);
		pty?.exit({ exitCode });
	}
	return { runner, runOnce };
}

test("a finished run is held with its result, timing and output", () => {
	const { runner, runOnce } = fakeRunner();
	runOnce("essay", "tests", "1 failed\r\n", 1);
	const [run, ...rest] = runner.finishedFor("essay");
	expect(rest).toEqual([]);
	expect(run).toMatchObject({ checkId: "tests", state: "failed", exitCode: 1 });
	expect(Buffer.from(run?.output ?? "", "base64").toString()).toBe("1 failed\r\n");
	expect(Date.parse(run?.endedAt ?? "")).toBeGreaterThanOrEqual(
		Date.parse(run?.startedAt ?? ""),
	);
	// What the agent sends is what the control plane accepts.
	expect(FinishedCheckRunsResponse.safeParse({ runs: [run] }).success).toBe(true);
});

test("a running check is not held, and another project's runs are not reported", () => {
	const { runner, runOnce } = fakeRunner();
	runOnce("other", "tests", "", 0);
	runner.start({
		slug: "essay",
		check: { id: "slow", name: "s", command: "x" },
		cwd: "/",
	});
	expect(runner.finishedFor("essay")).toEqual([]);
	expect(runner.finishedFor("other")).toHaveLength(1);
});

test("a run that could not start is held as an error with no exit code", () => {
	const runner = new CheckRunner(quietLog, (() => {
		throw new Error("no pty");
	}) as never);
	runner.start({
		slug: "essay",
		check: { id: "t", name: "t", command: "x" },
		cwd: "/",
	});
	expect(runner.finishedFor("essay")).toMatchObject([
		{ state: "error", exitCode: null },
	]);
});

test("only the tail of the output is held", () => {
	const { runner, runOnce } = fakeRunner();
	runOnce(
		"essay",
		"tests",
		`${"a".repeat(10)}${"b".repeat(MAX_STORED_CHECK_OUTPUT_BYTES)}`,
		0,
	);
	const output = Buffer.from(runner.finishedFor("essay")[0]?.output ?? "", "base64");
	expect(output.length).toBe(MAX_STORED_CHECK_OUTPUT_BYTES);
	expect(output.toString()).toBe("b".repeat(MAX_STORED_CHECK_OUTPUT_BYTES));
});

test("the newest runs of a check are kept, and the hold is bounded overall", () => {
	const { runner, runOnce } = fakeRunner();
	for (let i = 0; i < CHECK_HISTORY_PER_CHECK + 3; i++)
		runOnce("essay", "tests", `${i}`, 0);
	const kept = runner.finishedFor("essay");
	expect(kept).toHaveLength(CHECK_HISTORY_PER_CHECK);
	expect(Buffer.from(kept[0]?.output ?? "", "base64").toString()).toBe("3");

	for (let i = 0; i < MAX_HELD_FINISHED_RUNS; i++)
		runOnce("other", `c${i % 10}`, "", 0);
	expect(runner.finishedFor("essay")).toEqual([]);
	expect(runner.finishedFor("other")).toHaveLength(MAX_HELD_FINISHED_RUNS);
});
