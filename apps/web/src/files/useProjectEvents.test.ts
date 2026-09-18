import type { FsEvent } from "@portikus/contracts";
import { QueryClient } from "@tanstack/react-query";
import { expect, test, vi } from "vitest";
import { fileKeys } from "./queries.js";
import { applyInvalidations, invalidationsFor } from "./useProjectEvents.js";

function frame(partial: Partial<FsEvent> = {}): FsEvent {
	return { type: "fs", paths: [], git: false, truncated: false, ...partial };
}

test("each path asks for its own directory and its own file", () => {
	const work = invalidationsFor([frame({ paths: ["src/a.ts", "README.md"] })]);
	expect(work.trees.sort()).toEqual(["", "src"]);
	expect(work.files.sort()).toEqual(["README.md", "src/a.ts"]);
	expect(work.git).toBe(false);
	expect(work.all).toBe(false);
});

test("a git frame asks for the Git status and nothing else", () => {
	const work = invalidationsFor([frame({ git: true })]);
	expect(work.git).toBe(true);
	expect(work.trees).toEqual([]);
	expect(work.files).toEqual([]);
});

test("a truncated frame asks for everything and drops the path list", () => {
	const work = invalidationsFor([
		frame({ paths: ["src/a.ts"] }),
		frame({ truncated: true, git: true }),
	]);
	expect(work.all).toBe(true);
	expect(work.git).toBe(true);
	expect(work.trees).toEqual([]);
	expect(work.files).toEqual([]);
});

test("a batch refetches each named key once", () => {
	const client = new QueryClient();
	const invalidate = vi
		.spyOn(client, "invalidateQueries")
		.mockReturnValue(Promise.resolve());
	applyInvalidations(client, "ws", "pid", {
		git: true,
		trees: ["src"],
		files: ["src/a.ts"],
		all: false,
	});
	const keys = invalidate.mock.calls.map((call) => call[0]?.queryKey);
	expect(keys).toContainEqual(fileKeys.git("ws", "pid", false));
	expect(keys).toContainEqual(fileKeys.git("ws", "pid", true));
	expect(keys).toContainEqual(fileKeys.tree("ws", "pid", "src"));
	expect(keys).toContainEqual(fileKeys.file("ws", "pid", "src/a.ts"));
	expect(keys).toContainEqual(fileKeys.diff("ws", "pid", "src/a.ts"));
});

test("a git frame rewrites every open diff of the project", () => {
	const client = new QueryClient();
	const invalidate = vi
		.spyOn(client, "invalidateQueries")
		.mockReturnValue(Promise.resolve());
	applyInvalidations(client, "ws", "pid", {
		git: true,
		trees: [],
		files: [],
		all: false,
	});
	const predicate = invalidate.mock.calls
		.map((call) => call[0]?.predicate)
		.find((value) => value !== undefined);
	if (!predicate) throw new Error("a git frame needs a diff predicate");
	const match = (queryKey: readonly unknown[]) => predicate({ queryKey } as never);
	expect(match(fileKeys.diff("ws", "pid", "a.ts"))).toBe(true);
	expect(match(fileKeys.diff("ws", "other", "a.ts"))).toBe(false);
});

test("everything is refetched by a predicate that matches this project only", () => {
	const client = new QueryClient();
	const invalidate = vi
		.spyOn(client, "invalidateQueries")
		.mockReturnValue(Promise.resolve());
	applyInvalidations(client, "ws", "pid", {
		git: false,
		trees: [],
		files: [],
		all: true,
	});
	expect(invalidate).toHaveBeenCalledTimes(1);
	const predicate = invalidate.mock.calls[0]?.[0]?.predicate;
	if (!predicate) throw new Error("the whole-project refetch needs a predicate");
	const match = (queryKey: readonly unknown[]) => predicate({ queryKey } as never);
	expect(match(fileKeys.tree("ws", "pid", "src"))).toBe(true);
	expect(match(fileKeys.file("ws", "pid", "src/a.ts"))).toBe(true);
	expect(match(fileKeys.diff("ws", "pid", "src/a.ts"))).toBe(true);
	expect(match(fileKeys.tree("ws", "other", "src"))).toBe(false);
	expect(match(["projects", "ws"])).toBe(false);
});
