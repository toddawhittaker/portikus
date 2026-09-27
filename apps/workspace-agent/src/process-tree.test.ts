/**
 * Which processes a tree stop reaches (SPEC.md §9.7, §18.1): the root, its
 * descendants, its session when it leads one, and never the agent itself.
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
	collectProcessTree,
	killProcessTree,
	readStartTime,
	stopProcesses,
	type TreeProcess,
} from "./process-tree.js";

test("a root that does not lead a session never pulls in the agent's session", async () => {
	// A plain child shares this process's session; only it is collected.
	const child = spawn("sleep", ["30"]);
	try {
		const tree = await collectProcessTree(child.pid as number);
		expect(tree.map((entry) => entry.pid)).toEqual([child.pid]);
	} finally {
		child.kill("SIGKILL");
	}
});

test("the agent itself is never part of a tree", async () => {
	const tree = await collectProcessTree(process.pid);
	expect(tree.map((entry) => entry.pid)).not.toContain(process.pid);
});

test("a missing root is an empty tree", async () => {
	expect(await collectProcessTree(2 ** 22 + 1)).toEqual([]);
});

test("a process that ignores SIGTERM gets SIGKILL after the grace period", async () => {
	const stubborn = spawn("bash", ["-c", "trap '' TERM; sleep 30 & wait"], {
		detached: true,
	});
	await new Promise((resolve) => setTimeout(resolve, 200));
	const exited = new Promise((resolve) => stubborn.on("exit", resolve));
	await killProcessTree(stubborn.pid as number, undefined, 300);
	await expect(exited).resolves.toBeDefined();
});

test("a root whose start time does not match is left alone", async () => {
	const child = spawn("sleep", ["30"]);
	try {
		const pid = child.pid as number;
		const start = await readStartTime(pid);
		expect(start).not.toBeNull();
		expect(await collectProcessTree(pid, "1")).toEqual([]);
		expect((await collectProcessTree(pid, start as string)).map((e) => e.pid)).toEqual([
			pid,
		]);
	} finally {
		child.kill("SIGKILL");
	}
});

test("a zombie counts as gone, so no SIGKILL waits on it", async () => {
	// The parent never reaps its child, so the child stays a zombie.
	const parent = spawn("bash", ["-c", "sleep 0.05 & exec sleep 30"]);
	try {
		await new Promise((resolve) => setTimeout(resolve, 300));
		const tree = await collectProcessTree(parent.pid as number);
		const zombie = tree.find((entry) => entry.pid !== parent.pid);
		expect(zombie).toBeDefined();
		const started = Date.now();
		await stopProcesses([zombie as TreeProcess], 2000);
		expect(Date.now() - started).toBeLessThan(1000);
	} finally {
		parent.kill("SIGKILL");
	}
});

test("a process that joins the session during the grace period is killed too", async () => {
	// The leader ignores SIGTERM and starts a new member only after it.
	const pidFile = join(tmpdir(), `late-${process.pid}-${Date.now()}`);
	const leader = spawn(
		"bash",
		[
			"-c",
			`trap 'nohup sleep 30 >/dev/null 2>&1 & echo $! > ${pidFile}' TERM; while :; do sleep 0.05; done`,
		],
		{ detached: true },
	);
	try {
		await new Promise((resolve) => setTimeout(resolve, 200));
		await killProcessTree(leader.pid as number, undefined, 500);
		await new Promise((resolve) => setTimeout(resolve, 100));
		const late = Number.parseInt(await readFile(pidFile, "utf8"), 10);
		expect(late).toBeGreaterThan(0);
		expect(await readStartTime(late)).toBeNull();
	} finally {
		leader.kill("SIGKILL");
	}
});
