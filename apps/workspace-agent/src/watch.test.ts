/**
 * The project watcher against a real temporary directory and real chokidar
 * (SPEC.md §11.4, §25.1).
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FsEvent } from "@portikus/contracts";
import { collectingLogger } from "@portikus/observability/testing";
import type { FastifyBaseLogger } from "fastify";
import { afterEach, beforeEach, expect, test } from "vitest";
import { ProjectWatchers } from "./watch.js";

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
async function listen(): Promise<FsEvent[]> {
	const frames: FsEvent[] = [];
	stops.push(
		await watchers.subscribe(homeDir, "demo", (event) => {
			frames.push(event);
		}),
	);
	return frames;
}

async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

test("a written file arrives as one frame with its relative path", async () => {
	const frames = await listen();
	const started = Date.now();
	await writeFile(join(project, "notes.txt"), "hello");
	await waitFor(() => frames.length > 0);
	expect(frames.length).toBeGreaterThan(0);
	expect(Date.now() - started).toBeLessThan(500);
	const paths = frames.flatMap((frame) => frame.paths);
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
	await waitFor(() => frames.some((frame) => frame.truncated));
	const truncated = frames.find((frame) => frame.truncated);
	expect(truncated).toBeDefined();
	for (const frame of frames) expect(frame.paths.length).toBeLessThanOrEqual(200);
});

test("a change under .git sets git and lists no .git path", async () => {
	await mkdir(join(project, ".git"), { recursive: true });
	const frames = await listen();
	await writeFile(join(project, ".git", "index"), "x");
	await waitFor(() => frames.some((frame) => frame.git));
	expect(frames.some((frame) => frame.git)).toBe(true);
	for (const frame of frames) {
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
	const first: FsEvent[] = [];
	const second: FsEvent[] = [];
	const stopFirst = await watchers.subscribe(homeDir, "demo", (event) => {
		first.push(event);
	});
	const stopSecond = await watchers.subscribe(homeDir, "demo", (event) => {
		second.push(event);
	});
	expect(watchers.size()).toBe(1);

	await writeFile(join(project, "shared.txt"), "x");
	await waitFor(() => first.length > 0 && second.length > 0);
	expect(first.flatMap((frame) => frame.paths)).toContain("shared.txt");
	expect(second.flatMap((frame) => frame.paths)).toContain("shared.txt");

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
