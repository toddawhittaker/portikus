import { expect, test } from "vitest";
import { FsEvent, GENERATED_NAMES, WATCH_SKIP_NAMES, WatchLimited } from "./index.js";

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

test("the watcher skips more names than the tree hides", () => {
	for (const name of GENERATED_NAMES) expect(WATCH_SKIP_NAMES).toContain(name);
	expect(WATCH_SKIP_NAMES).toContain("venv");
	expect(GENERATED_NAMES as readonly string[]).not.toContain("venv");
	expect(WatchLimited.safeParse({ type: "watch_limited" }).success).toBe(true);
});
