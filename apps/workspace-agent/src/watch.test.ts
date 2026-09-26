/**
 * The project watcher against a real temporary directory and real chokidar
 * (SPEC.md §11.4, §25.1).
 */
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FsEvent } from "@portikus/contracts";
import { collectingLogger } from "@portikus/observability/testing";
import type { FSWatcher } from "chokidar";
import type { FastifyBaseLogger } from "fastify";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ProjectWatchers, WatchLimitedError } from "./watch.js";

let homeDir: string;
let project: string;
let watchers: ProjectWatchers;
const stops: (() => void)[] = [];

beforeEach(async () => {
	homeDir = await mkdtemp(join(tmpdir(), "portikus-watch-"));
	project = join(homeDir, "projects", "demo");
	await mkdir(project, { recursive: true });
	const { logger } = collectingLogger();
	watchers = new ProjectWatchers(logger as unknown as FastifyBaseLogger);
});

afterEach(async () => {
	for (const stop of stops.splice(0)) stop();
	watchers.closeEverything();
	await rm(homeDir, { recursive: true, force: true });
});

/** Collect frames from a subscription, remembering how to unsubscribe. */
async function listen(): Promise<(FsEvent | null)[]> {
	const frames: (FsEvent | null)[] = [];
	stops.push(
		await watchers.subscribe(homeDir, "demo", (event) => {
			frames.push(event);
		}),
	);
	return frames;
}

/** The change frames only, for the tests that do not care about failure. */
function events(frames: (FsEvent | null)[]): FsEvent[] {
	return frames.filter((frame): frame is FsEvent => frame !== null);
}

test("a written file arrives as one frame with its relative path", async () => {
	const frames = await listen();
	await writeFile(join(project, "notes.txt"), "hello");
	await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0), {
		timeout: 5000,
	});
	const paths = events(frames).flatMap((frame) => frame.paths);
	expect(paths).toContain("notes.txt");
	expect(frames[0]?.type).toBe("fs");
});

test("many files at once produce a truncated frame of at most 200 paths", async () => {
	const frames = await listen();
	await Promise.all(
		Array.from({ length: 300 }, (_, index) =>
			writeFile(join(project, `file-${index}.txt`), "x"),
		),
	);
	await vi.waitFor(
		() => expect(events(frames).some((frame) => frame.truncated)).toBe(true),
		{
			timeout: 5000,
		},
	);
	const truncated = events(frames).find((frame) => frame.truncated);
	expect(truncated).toBeDefined();
	for (const frame of events(frames))
		expect(frame.paths.length).toBeLessThanOrEqual(200);
});

test("a change under .git sets git and lists no .git path", async () => {
	await mkdir(join(project, ".git"), { recursive: true });
	const frames = await listen();
	await writeFile(join(project, ".git", "index"), "x");
	await vi.waitFor(() => expect(events(frames).some((frame) => frame.git)).toBe(true), {
		timeout: 5000,
	});
	expect(events(frames).some((frame) => frame.git)).toBe(true);
	for (const frame of events(frames)) {
		for (const path of frame.paths) expect(path.startsWith(".git")).toBe(false);
	}
});

test("changes under node_modules produce nothing", async () => {
	await mkdir(join(project, "node_modules", "left-pad"), { recursive: true });
	const frames = await listen();
	await writeFile(join(project, "node_modules", "left-pad", "index.js"), "x");
	await new Promise((resolve) => setTimeout(resolve, 600));
	expect(frames).toEqual([]);
});

test("two subscribers share one watcher, which closes when both leave", async () => {
	const first: (FsEvent | null)[] = [];
	const second: (FsEvent | null)[] = [];
	const stopFirst = await watchers.subscribe(homeDir, "demo", (event) => {
		first.push(event);
	});
	const stopSecond = await watchers.subscribe(homeDir, "demo", (event) => {
		second.push(event);
	});
	expect(watchers.size()).toBe(1);

	await writeFile(join(project, "shared.txt"), "x");
	await vi.waitFor(
		() => {
			expect(first.length).toBeGreaterThan(0);
			expect(second.length).toBeGreaterThan(0);
		},
		{ timeout: 5000 },
	);
	expect(events(first).flatMap((frame) => frame.paths)).toContain("shared.txt");
	expect(events(second).flatMap((frame) => frame.paths)).toContain("shared.txt");

	stopFirst();
	expect(watchers.size()).toBe(1);
	stopSecond();
	expect(watchers.size()).toBe(0);
});

test("a missing project is rejected", async () => {
	await expect(watchers.subscribe(homeDir, "nope", () => {})).rejects.toThrow(
		/no such project/,
	);
});

test("changes through a symlink that leaves the project produce nothing", async () => {
	const outside = join(homeDir, "outside");
	await mkdir(outside, { recursive: true });
	await symlink(outside, join(project, "link"));
	const frames = await listen();
	await writeFile(join(project, "link", "secret.txt"), "x");
	await new Promise((resolve) => setTimeout(resolve, 600));
	expect(events(frames).flatMap((frame) => frame.paths)).not.toContain(
		"link/secret.txt",
	);
	expect(events(frames).flatMap((frame) => frame.paths)).toEqual([]);
});

test("a project that cannot be watched is rejected instead of hanging", async () => {
	const closed = join(homeDir, "projects", "closed");
	await mkdir(closed, { recursive: true });
	await chmod(closed, 0o000);
	try {
		await expect(watchers.subscribe(homeDir, "closed", () => {})).rejects.toThrow(
			/could not watch project/,
		);
	} finally {
		await chmod(closed, 0o700);
	}
	// Nothing is left behind, so the next subscriber starts clean.
	expect(watchers.size()).toBe(0);
});

test("a failed watcher tells its subscribers and is replaced by the next one", async () => {
	const first = await listen();
	const entries = (
		watchers as unknown as { entries: Map<string, { watcher: FSWatcher }> }
	).entries;
	const broken = [...entries.values()][0]?.watcher;
	broken?.emit("error", Object.assign(new Error("boom"), { code: "EIO" }));
	// The failure itself reaches the subscriber, so its socket can say so.
	await vi.waitFor(() => expect(first).toContain(null), { timeout: 5000 });
	expect(watchers.size()).toBe(0);

	const second = await listen();
	expect(watchers.size()).toBe(1);
	await writeFile(join(project, "after.txt"), "x");
	await vi.waitFor(
		() => expect(events(second).flatMap((frame) => frame.paths)).toContain("after.txt"),
		{ timeout: 5000 },
	);
});

test("changes under each extra skipped folder produce nothing", async () => {
	const extra = [
		"venv",
		"env",
		".next",
		".cache",
		"vendor",
		"coverage",
		".gradle",
		".pytest_cache",
		".mypy_cache",
		".tox",
	];
	for (const name of extra) await mkdir(join(project, name), { recursive: true });
	const frames = await listen();
	for (const name of extra) await writeFile(join(project, name, "x.txt"), "x");
	await writeFile(join(project, "seen.txt"), "x");
	await vi.waitFor(
		() => expect(events(frames).flatMap((f) => f.paths)).toContain("seen.txt"),
		{ timeout: 5000 },
	);
	const paths = events(frames).flatMap((frame) => frame.paths);
	for (const name of extra) {
		expect(paths.some((path) => path.startsWith(`${name}/`))).toBe(false);
	}
});

test("a project past the folder cap is refused with WatchLimitedError and no watcher is kept", async () => {
	const { logger } = collectingLogger();
	const capped = new ProjectWatchers(logger as unknown as FastifyBaseLogger, 3);
	for (const name of ["a", "b", "c", "d"]) await mkdir(join(project, name));
	await expect(capped.subscribe(homeDir, "demo", () => {})).rejects.toBeInstanceOf(
		WatchLimitedError,
	);
	expect(capped.size()).toBe(0);
});

test("a project at the folder cap is watched", async () => {
	const { logger } = collectingLogger();
	const capped = new ProjectWatchers(logger as unknown as FastifyBaseLogger, 3);
	// The project root counts, so two folders make three.
	for (const name of ["a", "b"]) await mkdir(join(project, name));
	const stop = await capped.subscribe(homeDir, "demo", () => {});
	expect(capped.size()).toBe(1);
	stop();
});

test("a project that takes too long to scan is refused with WatchLimitedError", async () => {
	const { logger } = collectingLogger();
	const slow = new ProjectWatchers(logger as unknown as FastifyBaseLogger, 1000, 1);
	for (const name of ["a", "b", "c", "d"]) await mkdir(join(project, name));
	await expect(slow.subscribe(homeDir, "demo", () => {})).rejects.toBeInstanceOf(
		WatchLimitedError,
	);
	expect(slow.size()).toBe(0);
});
