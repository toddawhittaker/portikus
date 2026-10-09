import { describe, expect, test } from "vitest";
// @ts-expect-error The script is a plain .mjs script with no type declarations.
import { otherWriters, willSign } from "./apt-writers.mjs";

const runs = [
	{ id: 1, event: "push", status: "queued" },
	{ id: 2, event: "push", status: "in_progress" },
	{ id: 3, event: "workflow_dispatch", status: "waiting" },
	{ id: 4, event: "push", status: "completed" },
	{ id: 5, event: "schedule", status: "in_progress" },
	{ id: 6, event: "schedule", status: "queued" },
	{ id: 7, event: "schedule", status: "completed" },
	{ id: 8, event: "schedule", status: "waiting" },
];

const gate = (status = "completed") => ({
	name: "Decide whether this push is a release",
	status,
});
const build = (status: string) => ({ name: "Build the Debian package", status });
const apt = (status: string) => ({ name: "Sign the apt repository", status });

describe("otherWriters", () => {
	test("a re-sign checks every unfinished release", () => {
		expect(otherWriters(runs, "releases", 5)).toEqual([1, 2, 3]);
	});

	test("a release waits for a re-sign that is queued, waiting or running", () => {
		expect(otherWriters(runs, "resigns", 2)).toEqual([5, 6, 8]);
	});

	test("a run never counts itself", () => {
		expect(otherWriters(runs, "resigns", "5")).toEqual([6, 8]);
		expect(otherWriters(runs, "releases", "2")).toEqual([1, 3]);
	});
});

describe("willSign", () => {
	test("a run whose gate has not finished counts, since it may release", () => {
		expect(willSign([])).toBe(true);
		expect(willSign([gate("queued")])).toBe(true);
		expect(willSign([gate("in_progress"), build("queued"), apt("queued")])).toBe(true);
	});

	test("a release that is building or signing counts", () => {
		expect(willSign([gate(), build("in_progress"), apt("queued")])).toBe(true);
		expect(willSign([gate(), build("completed"), apt("queued")])).toBe(true);
		expect(willSign([gate(), build("completed"), apt("in_progress")])).toBe(true);
	});

	test("a release whose apt job waits for approval does not count", () => {
		expect(willSign([gate(), build("completed"), apt("waiting")])).toBe(false);
	});

	test("a push the gate ruled no release does not count", () => {
		expect(willSign([gate(), build("completed"), apt("completed")])).toBe(false);
	});

	test("a release whose build failed does not count", () => {
		expect(willSign([gate(), build("completed"), apt("completed")])).toBe(false);
		expect(willSign([gate(), build("completed")])).toBe(false);
	});
});
