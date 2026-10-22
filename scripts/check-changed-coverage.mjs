#!/usr/bin/env node
/**
 * Fail a pull request whose added or changed lines are mostly untested. The
 * repository-wide floors in vitest.config.ts let a large untested file hide
 * in the totals; new code has no legacy to hide behind.
 *
 *   node scripts/check-changed-coverage.mjs <base-ref> [lcov-path]
 *
 * Reads the merged report (default coverage/lcov.info) and the changed lines
 * from `git diff -U0 <base-ref>...HEAD`. Only files the vitest coverage config
 * measures count, and only lines lcov lists as instrumented, so comments,
 * blank lines and types never count against a change.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { matchesGlob, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
// Imported, not copied, so the check cannot drift from what vitest measures.
import config from "../vitest.config.ts";

export const THRESHOLD = 80;

const { include, exclude } = config.test.coverage;

/** True when the vitest coverage config measures this repository-relative path. */
export function isMeasured(path) {
	return (
		include.some((glob) => matchesGlob(path, glob)) &&
		!exclude.some((glob) => matchesGlob(path, glob))
	);
}

/** Map each file the diff touches to the set of line numbers it adds or changes. */
export function parseDiff(diff) {
	const files = new Map();
	let lines = null;
	let previous = "";
	for (const line of diff.split("\n")) {
		const prior = previous;
		previous = line;
		// A file header follows its `--- ` line; an added line whose text
		// starts with `++ ` also begins `+++ ` but never follows one.
		if (line.startsWith("+++ ") && prior.startsWith("--- ")) {
			// `+++ /dev/null` is a deleted file: nothing was added.
			lines = null;
			if (line.startsWith("+++ b/")) {
				lines = new Set();
				files.set(line.slice(6), lines);
			}
			continue;
		}
		const hunk = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(line);
		if (hunk && lines) {
			const start = Number(hunk[1]);
			const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
			for (let n = start; n < start + count; n++) lines.add(n);
		}
	}
	return files;
}

/** Map each file in an lcov report to its instrumented lines and their hit counts. */
export function parseLcov(lcov, cwd = process.cwd()) {
	const files = new Map();
	let hits = null;
	for (const line of lcov.split("\n")) {
		if (line.startsWith("SF:")) {
			const path = relative(cwd, line.slice(3).trim()).split(sep).join("/");
			hits = files.get(path) ?? new Map();
			files.set(path, hits);
		} else if (line.startsWith("DA:") && hits) {
			const [n, count] = line.slice(3).split(",").map(Number);
			hits.set(n, Math.max(hits.get(n) ?? 0, count));
		} else if (line === "end_of_record") {
			hits = null;
		}
	}
	return files;
}

/** Count changed, measured, instrumented lines and list the uncovered ones. */
export function evaluate(changed, lcovFiles) {
	let measurable = 0;
	let covered = 0;
	const uncovered = new Map();
	for (const [path, added] of changed) {
		const hits = lcovFiles.get(path);
		if (!hits || !isMeasured(path)) continue;
		for (const n of [...added].sort((a, b) => a - b)) {
			if (!hits.has(n)) continue;
			measurable++;
			if (hits.get(n) > 0) {
				covered++;
			} else {
				uncovered.set(path, [...(uncovered.get(path) ?? []), n]);
			}
		}
	}
	// A diff with no measurable lines has nothing to cover.
	const percent = measurable === 0 ? 100 : (covered / measurable) * 100;
	return { measurable, covered, percent, passed: percent >= THRESHOLD, uncovered };
}

/** Collapse sorted line numbers into "3-5, 9" style ranges. */
export function formatRanges(numbers) {
	const ranges = [];
	for (const n of numbers) {
		const last = ranges[ranges.length - 1];
		if (last && n === last[1] + 1) last[1] = n;
		else ranges.push([n, n]);
	}
	return ranges.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(", ");
}

export function report({ measurable, covered, percent, passed, uncovered }) {
	if (measurable === 0) {
		return "No changed lines are measured by the coverage config, so there is nothing to check.";
	}
	const head = `Changed-line coverage: ${percent.toFixed(1)}% (${covered} of ${measurable} lines), ${passed ? "meets" : "below"} the ${THRESHOLD}% bar.`;
	if (uncovered.size === 0) return head;
	const rows = [...uncovered].map(([path, nums]) => `  ${path}:${formatRanges(nums)}`);
	return [head, "Uncovered changed lines:", ...rows].join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const [base, lcovPath = "coverage/lcov.info"] = process.argv.slice(2);
	if (!base) {
		console.error("usage: check-changed-coverage.mjs <base-ref> [lcov-path]");
		process.exit(2);
	}
	let diff;
	try {
		diff = execFileSync(
			"git",
			["-c", "core.quotePath=false", "diff", "-U0", "--no-renames", `${base}...HEAD`],
			{
				encoding: "utf8",
				maxBuffer: 256 * 1024 * 1024,
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
	} catch (error) {
		// Usually a shallow clone with no merge base; say so in one line.
		const reason = String(error.stderr ?? error.message)
			.trim()
			.split("\n")[0];
		console.error(`Cannot diff against ${base}: ${reason}`);
		process.exit(2);
	}
	const result = evaluate(parseDiff(diff), parseLcov(readFileSync(lcovPath, "utf8")));
	const text = report(result);
	console.log(text);
	if (process.env.GITHUB_STEP_SUMMARY) {
		appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\`\`\`\n${text}\n\`\`\`\n`);
	}
	if (!result.passed) process.exit(1);
}
