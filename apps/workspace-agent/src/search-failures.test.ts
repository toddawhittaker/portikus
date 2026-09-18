import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SEARCH_TIMEOUT_MS } from "@portikus/contracts";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { searchProject } from "./search.js";
import { AgentFailure } from "./tmux.js";

// These tests pin what a search must do when ripgrep misbehaves (SPEC.md
// §11.5: a search must not block the agent and must stay inside the
// project). They put a stand-in for `rg` first on PATH, so they run even
// where real ripgrep is not installed.

let homeDir: string;
let projectDir: string;
let binDir: string;
let realPath: string | undefined;

/** Write an executable stand-in for ripgrep and put it first on PATH. */
async function useFakeRg(body: string): Promise<void> {
	await writeFile(join(binDir, "rg"), `#!/bin/sh\n${body}`, { mode: 0o755 });
	process.env.PATH = `${binDir}:${realPath ?? ""}`;
}

/** One ripgrep --json stream with a single match in the project. */
function matchStream(): string {
	return [
		`printf '{"type":"begin","data":{"path":{"text":"%s/fake.txt"}}}\\n' "$PORTIKUS_TEST_PROJECT"`,
		`printf '{"type":"match","data":{"path":{"text":"%s/fake.txt"},"lines":{"text":"hello needle\\\\n"},"line_number":3,"submatches":[{"start":6}]}}\\n' "$PORTIKUS_TEST_PROJECT"`,
	].join("\n");
}

beforeAll(async () => {
	homeDir = await mkdtemp(join(tmpdir(), "portikus-search-fail-"));
	projectDir = join(homeDir, "projects", "demo");
	await mkdir(projectDir, { recursive: true });
	await writeFile(join(projectDir, "fake.txt"), "a\nb\nhello needle\nd\n");
	binDir = join(homeDir, "bin");
	await mkdir(binDir, { recursive: true });
	realPath = process.env.PATH;
	process.env.PORTIKUS_TEST_PROJECT = projectDir;
});

afterEach(() => {
	vi.useRealTimers();
	process.env.PATH = realPath;
});

afterAll(async () => {
	process.env.PATH = realPath;
	// Assigning undefined would leave the string "undefined" behind for any
	// test file that shares this worker.
	delete process.env.PORTIKUS_TEST_PROJECT;
	await rm(homeDir, { recursive: true, force: true });
});

test("ripgrep failing with exit code 2 is reported as SEARCH_FAILED", async () => {
	await useFakeRg('echo "rg: broken" >&2\nexit 2\n');
	await expect(
		searchProject(homeDir, "demo", "needle", { hidden: false }),
	).rejects.toMatchObject({ code: "SEARCH_FAILED" });
});

test("a search that cannot start ripgrep is reported as SEARCH_FAILED", async () => {
	// No ripgrep anywhere on PATH: spawn fails before any output.
	process.env.PATH = join(homeDir, "empty-bin");
	const error = await searchProject(homeDir, "demo", "needle", {
		hidden: false,
	}).catch((caught: unknown) => caught);
	expect(error).toBeInstanceOf(AgentFailure);
	expect(error).toMatchObject({ code: "SEARCH_FAILED" });
});

test("stderr noise and unparsable lines do not break the results", async () => {
	await useFakeRg(
		[
			"i=0",
			'while [ $i -lt 500 ]; do echo "rg: warning $i" >&2; i=$((i+1)); done',
			matchStream(),
			"printf 'this is not json\\n'",
			`printf '{"type":"end","data":{"path":{"text":"%s/fake.txt"}}}\\n' "$PORTIKUS_TEST_PROJECT"`,
			"exit 0",
		].join("\n"),
	);
	const result = await searchProject(homeDir, "demo", "needle", { hidden: false });
	expect(result.truncated).toBe(false);
	expect(result.matches).toEqual([
		{
			path: "fake.txt",
			line: 3,
			column: 7,
			text: "hello needle",
			before: [],
			after: [],
		},
	]);
});

test("a search that runs too long returns what it found, marked truncated", async () => {
	// exec, so that killing the child really ends the sleep.
	await useFakeRg([matchStream(), "exec sleep 60"].join("\n"));
	// Only setTimeout is faked, so the child's real output still arrives.
	vi.useFakeTimers({ toFake: ["setTimeout"] });
	const result = await searchProject(homeDir, "demo", "needle", {
		hidden: false,
		onChild: (child) => {
			// Time out as soon as the first results are on the wire.
			child.stdout?.once("data", () => vi.advanceTimersByTime(SEARCH_TIMEOUT_MS));
		},
	});
	expect(result.truncated).toBe(true);
	expect(result.matches).toHaveLength(1);
	expect(result.matches[0]?.path).toBe("fake.txt");
});

test("a signal already aborted returns an empty result and never spawns", async () => {
	await useFakeRg('echo "rg: should not run" >&2\nexit 2\n');
	const controller = new AbortController();
	controller.abort();
	let spawned = false;
	const result = await searchProject(homeDir, "demo", "needle", {
		hidden: false,
		signal: controller.signal,
		onChild: () => {
			spawned = true;
		},
	});
	expect(result).toEqual({ matches: [], truncated: false });
	expect(spawned).toBe(false);
});

test("an unknown project fails before ripgrep is ever started", async () => {
	await useFakeRg('echo "rg: should not run" >&2\nexit 2\n');
	let spawned = false;
	await expect(
		searchProject(homeDir, "no-such-project", "needle", {
			hidden: false,
			onChild: () => {
				spawned = true;
			},
		}),
	).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
	expect(spawned).toBe(false);
});
