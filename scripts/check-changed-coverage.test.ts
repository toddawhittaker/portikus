import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
// @ts-expect-error The script is a plain .mjs file with no type declarations.
import {
	evaluate,
	formatRanges,
	parseDiff,
	parseLcov,
} from "./check-changed-coverage.mjs";

const script = join(
	dirname(fileURLToPath(import.meta.url)),
	"check-changed-coverage.mjs",
);

function lcov(files: Record<string, Record<number, number>>): string {
	return Object.entries(files)
		.map(
			([path, lines]) =>
				`TN:\nSF:${path}\n${Object.entries(lines)
					.map(([n, hits]) => `DA:${n},${hits}`)
					.join("\n")}\nend_of_record\n`,
		)
		.join("");
}

describe("parseDiff", () => {
	test("collects added lines from hunks, with a missing count meaning one line", () => {
		const diff = [
			"diff --git a/apps/api/src/a.ts b/apps/api/src/a.ts",
			"--- a/apps/api/src/a.ts",
			"+++ b/apps/api/src/a.ts",
			"@@ -3,0 +4,2 @@",
			"+one",
			"+two",
			"@@ -10 +12 @@",
			"-old",
			"+new",
		].join("\n");
		expect([...parseDiff(diff).get("apps/api/src/a.ts")]).toEqual([4, 5, 12]);
	});

	test("a deleted file and a deletion-only hunk add no lines", () => {
		const diff = [
			"--- a/apps/api/src/gone.ts",
			"+++ /dev/null",
			"@@ -1,3 +0,0 @@",
			"--- a/apps/api/src/a.ts",
			"+++ b/apps/api/src/a.ts",
			"@@ -5,2 +4,0 @@",
		].join("\n");
		const files = parseDiff(diff);
		expect(files.has("apps/api/src/gone.ts")).toBe(false);
		expect(files.get("apps/api/src/a.ts").size).toBe(0);
	});
});

describe("parseDiff, added lines that look like file headers", () => {
	test("an added line whose text starts with `++ ` is counted, not read as a header", () => {
		const diff = [
			"diff --git a/apps/api/src/a.ts b/apps/api/src/a.ts",
			"--- a/apps/api/src/a.ts",
			"+++ b/apps/api/src/a.ts",
			"@@ -3,0 +4,2 @@",
			"+++ b/apps/api/src/not-a-file.ts",
			"+two",
		].join("\n");
		const files = parseDiff(diff);
		expect([...files.keys()]).toEqual(["apps/api/src/a.ts"]);
		expect([...files.get("apps/api/src/a.ts")]).toEqual([4, 5]);
	});
});

describe("parseLcov", () => {
	test("makes absolute paths relative and keeps the highest count for repeated lines", () => {
		const text = lcov({
			"/repo/apps/api/src/a.ts": { 1: 0, 2: 3 },
		}).concat(lcov({ "/repo/apps/api/src/a.ts": { 1: 2 } }));
		const files = parseLcov(text, "/repo");
		expect([...files.get("apps/api/src/a.ts")]).toEqual([
			[1, 2],
			[2, 3],
		]);
	});
});

describe("evaluate", () => {
	const path = "apps/api/src/a.ts";
	const changed = (...n: number[]) => new Map([[path, new Set(n)]]);

	test("passes when every changed instrumented line is covered", () => {
		const result = evaluate(
			changed(1, 2, 3),
			parseLcov(lcov({ [path]: { 1: 1, 2: 4, 3: 1 } })),
		);
		expect(result).toMatchObject({
			measurable: 3,
			covered: 3,
			percent: 100,
			passed: true,
		});
	});

	test("fails below 80% and lists the uncovered lines", () => {
		const hits = { 1: 1, 2: 0, 3: 0, 4: 1, 5: 0 };
		const result = evaluate(changed(1, 2, 3, 4, 5), parseLcov(lcov({ [path]: hits })));
		expect(result.passed).toBe(false);
		expect(result.percent).toBe(40);
		expect(result.uncovered.get(path)).toEqual([2, 3, 5]);
	});

	test("exactly 80% passes", () => {
		const hits = { 1: 1, 2: 1, 3: 1, 4: 1, 5: 0 };
		expect(
			evaluate(changed(1, 2, 3, 4, 5), parseLcov(lcov({ [path]: hits }))).passed,
		).toBe(true);
	});

	test("lines lcov does not list, such as comments and types, do not count", () => {
		const result = evaluate(changed(1, 2, 3, 4), parseLcov(lcov({ [path]: { 2: 1 } })));
		expect(result).toMatchObject({ measurable: 1, covered: 1, passed: true });
	});

	test("files outside the include list or inside the exclude list are skipped", () => {
		const excluded = "apps/api/src/index.ts";
		const testFile = "apps/api/src/a.test.ts";
		const elsewhere = "scripts/tool.mjs";
		const report = parseLcov(
			lcov({
				[excluded]: { 1: 0 },
				[testFile]: { 1: 0 },
				[elsewhere]: { 1: 0 },
			}),
		);
		const diff = new Map([
			[excluded, new Set([1])],
			[testFile, new Set([1])],
			[elsewhere, new Set([1])],
		]);
		expect(evaluate(diff, report)).toMatchObject({
			measurable: 0,
			passed: true,
			percent: 100,
		});
	});

	test("a file the report does not know about is skipped", () => {
		expect(evaluate(changed(1), new Map())).toMatchObject({
			measurable: 0,
			passed: true,
		});
	});
});

describe("formatRanges", () => {
	test("joins consecutive lines into ranges", () => {
		expect(formatRanges([2, 3, 4, 7, 9, 10])).toBe("2-4, 7, 9-10");
	});
});

describe("script against a real git repository", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function git(dir: string, ...args: string[]) {
		execFileSync(
			"git",
			["-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
			{
				cwd: dir,
				stdio: "ignore",
			},
		);
	}

	function write(dir: string, path: string, text: string) {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), text);
	}

	/** A repo with one committed file on `base`, then `change` applied and committed. */
	function repo(change: (dir: string) => void) {
		const dir = mkdtempSync(join(tmpdir(), "changed-coverage-"));
		dirs.push(dir);
		git(dir, "init", "-q", "-b", "main");
		write(dir, "apps/api/src/old.ts", "a\nb\nc\n");
		git(dir, "add", ".");
		git(dir, "commit", "-q", "-m", "base");
		git(dir, "switch", "-q", "-c", "topic");
		change(dir);
		git(dir, "add", ".");
		git(dir, "commit", "-q", "-m", "change");
		return dir;
	}

	function run(dir: string, report: Record<string, Record<number, number>>) {
		writeFileSync(join(dir, "lcov.info"), lcov(report));
		const summary = join(dir, "summary.md");
		const result = spawnSync("node", [script, "main", join(dir, "lcov.info")], {
			cwd: dir,
			encoding: "utf8",
			env: { ...process.env, GITHUB_STEP_SUMMARY: summary },
		});
		return { status: result.status, out: result.stdout, err: result.stderr, summary };
	}

	test("a new file that is fully covered passes", () => {
		const dir = repo((d) => write(d, "apps/api/src/new.ts", "x\ny\nz\n"));
		const { status, out } = run(dir, {
			[join(dir, "apps/api/src/new.ts")]: { 1: 1, 2: 1, 3: 2 },
		});
		expect(status).toBe(0);
		expect(out).toContain("100.0% (3 of 3 lines)");
	});

	test("a new file that is mostly uncovered fails and names the lines", () => {
		const dir = repo((d) => write(d, "apps/api/src/new.ts", "x\ny\nz\nw\n"));
		const { status, out } = run(dir, {
			[join(dir, "apps/api/src/new.ts")]: { 1: 1, 2: 0, 3: 0, 4: 0 },
		});
		expect(status).toBe(1);
		expect(out).toContain("25.0% (1 of 4 lines)");
		expect(out).toContain("apps/api/src/new.ts:2-4");
	});

	test("a change to an excluded path passes even when uncovered", () => {
		const dir = repo((d) => write(d, "apps/api/src/index.ts", "x\ny\n"));
		const { status, out } = run(dir, {
			[join(dir, "apps/api/src/index.ts")]: { 1: 0, 2: 0 },
		});
		expect(status).toBe(0);
		expect(out).toContain("nothing to check");
	});

	test("a diff that only deletes lines passes", () => {
		const dir = repo((d) => {
			write(d, "apps/api/src/old.ts", "a\n");
		});
		const { status, out } = run(dir, { [join(dir, "apps/api/src/old.ts")]: { 1: 0 } });
		expect(status).toBe(0);
		expect(out).toContain("nothing to check");
	});

	test("a deleted file passes", () => {
		const dir = repo((d) => rmSync(join(d, "apps/api/src/old.ts")));
		expect(run(dir, {}).status).toBe(0);
	});

	test("a diff with only comments or blank lines passes", () => {
		const dir = repo((d) => write(d, "apps/api/src/old.ts", "a\nb\nc\n// note\n\n"));
		const { status } = run(dir, {
			[join(dir, "apps/api/src/old.ts")]: { 1: 1, 2: 1, 3: 1 },
		});
		expect(status).toBe(0);
	});

	test("writes the result to the step summary file", () => {
		const dir = repo((d) => write(d, "apps/api/src/new.ts", "x\n"));
		const { summary } = run(dir, { [join(dir, "apps/api/src/new.ts")]: { 1: 0 } });
		expect(readFileSync(summary, "utf8")).toContain("0.0% (0 of 1 lines)");
	});

	test("exits 2 with one line, not a stack trace, when git finds no merge base", () => {
		const dir = repo((d) => write(d, "apps/api/src/new.ts", "x\n"));
		git(dir, "switch", "-q", "--orphan", "unrelated");
		git(dir, "commit", "-q", "--allow-empty", "-m", "unrelated");
		const result = run(dir, {});
		expect(result.status).toBe(2);
		expect(result.err.trim().split("\n")).toHaveLength(1);
		expect(result.err).toContain("Cannot diff against main");
	});

	test("exits 2 without a base argument", () => {
		const result = spawnSync("node", [script], { encoding: "utf8" });
		expect(result.status).toBe(2);
	});
});
