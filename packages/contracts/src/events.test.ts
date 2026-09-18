import { expect, test } from "vitest";
import {
	FS_EVENT_BATCH_MS,
	FsEvent,
	GENERATED_NAMES,
	MAX_FS_EVENT_PATHS,
} from "./index.js";

test("an fs event carries relative paths, a git flag, and a truncated flag", () => {
	const parsed = FsEvent.parse({
		type: "fs",
		paths: ["src/main.ts"],
		git: true,
		truncated: false,
	});
	expect(parsed.paths).toEqual(["src/main.ts"]);
	expect(parsed.git).toBe(true);
});

test("an fs event rejects an unknown type", () => {
	expect(
		FsEvent.safeParse({ type: "git", paths: [], git: false, truncated: false }).success,
	).toBe(false);
});

test("the batching constants and generated names are what clients expect", () => {
	expect(FS_EVENT_BATCH_MS).toBe(150);
	expect(MAX_FS_EVENT_PATHS).toBe(200);
	expect(GENERATED_NAMES).toContain(".git");
	expect(GENERATED_NAMES).toContain("node_modules");
});
