/**
 * Which processes a tree stop reaches (SPEC.md §9.7, §18.1): the root, its
 * descendants, its session when it leads one, and never the agent itself.
 */
import { spawn } from "node:child_process";
import { expect, test } from "vitest";
import { collectProcessTree, killProcessTree } from "./process-tree.js";

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
	await killProcessTree(stubborn.pid as number, 300);
	await expect(exited).resolves.toBeDefined();
});
