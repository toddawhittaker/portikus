import { describe, expect, test } from "vitest";
// @ts-expect-error The script is a plain .mjs script with no type declarations.
import { otherWriters } from "./apt-writers.mjs";

const runs = [
	{ id: 1, event: "push", status: "queued" },
	{ id: 2, event: "push", status: "in_progress" },
	{ id: 3, event: "workflow_dispatch", status: "waiting" },
	{ id: 4, event: "push", status: "completed" },
	{ id: 5, event: "schedule", status: "in_progress" },
	{ id: 6, event: "schedule", status: "queued" },
	{ id: 7, event: "schedule", status: "completed" },
];

describe("otherWriters", () => {
	test("a re-sign sees every unfinished release, queued or running", () => {
		expect(otherWriters(runs, "releases", 5)).toEqual([1, 2, 3]);
	});

	test("a release waits only for re-signs that have started", () => {
		expect(otherWriters(runs, "resigns", 2)).toEqual([5]);
	});

	test("a run never counts itself", () => {
		expect(otherWriters(runs, "resigns", "5")).toEqual([]);
		expect(otherWriters(runs, "releases", "2")).toEqual([1, 3]);
	});
});
