#!/usr/bin/env node
/**
 * Split the browser tests into CI shards by measured time, not test count.
 *
 *   node scripts/e2e-shard-list.mjs <index> <total> <out-file>
 *     Writes the spec files for shard <index> of <total> to <out-file>,
 *     one per line, for `playwright test --test-list <out-file>`.
 *
 *   node scripts/e2e-shard-list.mjs --refresh [run-id]
 *     Rebuilds e2e/shard-timings.json from a CI run's shard logs; without a
 *     run id it uses the latest successful CI run on main.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

const TIMINGS = fileURLToPath(new URL("../e2e/shard-timings.json", import.meta.url));

/**
 * Pack files into `total` shards, longest first, each into the shard with the
 * least time so far. Files without a timing count as the average.
 */
export function packShards(files, timings, total) {
	const known = files.filter((file) => file in timings).map((file) => timings[file]);
	const average = known.length ? known.reduce((a, b) => a + b, 0) / known.length : 1;
	const weighted = files.map((file) => ({ file, seconds: timings[file] ?? average }));
	// Ties break on the name so every shard computes the same plan.
	weighted.sort((a, b) => b.seconds - a.seconds || (a.file < b.file ? -1 : 1));
	const shards = Array.from({ length: total }, () => ({ files: [], seconds: 0 }));
	for (const { file, seconds } of weighted) {
		let target = shards[0];
		for (const shard of shards) if (shard.seconds < target.seconds) target = shard;
		target.files.push(file);
		target.seconds += seconds;
	}
	return shards;
}

/** Sum test durations per spec file from Playwright list reporter output. */
export function parseTimings(log) {
	const timings = {};
	const plain = stripVTControlCharacters(log);
	const line =
		/\[(?:chromium|docker)\] › e2e\/(\S+?):\d+:\d+ › .*\((\d+(?:\.\d+)?)(m?s)\)\s*$/;
	for (const text of plain.split("\n")) {
		const match = line.exec(text);
		if (!match) continue;
		const seconds = Number(match[2]) / (match[3] === "ms" ? 1000 : 1);
		timings[match[1]] = (timings[match[1]] ?? 0) + seconds;
	}
	return timings;
}

/** Spec files the browser projects would run, relative to the test directory. */
function listSpecFiles() {
	const json = execFileSync(
		"pnpm",
		["exec", "playwright", "test", "--list", "--reporter=json"],
		{
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
		},
	);
	const files = new Set();
	const walk = (suite) => {
		for (const spec of suite.specs ?? []) {
			if (spec.tests.some((test) => test.projectName !== "setup")) files.add(spec.file);
		}
		for (const child of suite.suites ?? []) walk(child);
	};
	for (const suite of JSON.parse(json).suites) walk(suite);
	return [...files].sort();
}

function refresh(runId) {
	const gh = (...args) =>
		execFileSync("gh", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
	const id =
		runId ??
		gh(
			"run",
			"list",
			"--workflow",
			"ci.yml",
			"--branch",
			"main",
			"--status",
			"success",
			"--limit",
			"1",
			"--json",
			"databaseId",
			"-q",
			".[0].databaseId",
		).trim();
	const jobs = gh(
		"run",
		"view",
		id,
		"--json",
		"jobs",
		"-q",
		'.jobs[] | select(.name | startswith("Browser end-to-end tests (shard")) | .databaseId',
	)
		.split("\n")
		.filter(Boolean);
	const timings = {};
	for (const job of jobs)
		Object.assign(timings, parseTimings(gh("run", "view", "--job", job, "--log")));
	const sorted = Object.fromEntries(
		Object.keys(timings)
			.sort()
			.map((file) => [file, Math.round(timings[file] * 10) / 10]),
	);
	writeFileSync(TIMINGS, `${JSON.stringify(sorted, null, "\t")}\n`);
	console.log(`Wrote ${Object.keys(sorted).length} files from run ${id} to ${TIMINGS}`);
}

function main(args) {
	if (args[0] === "--refresh") return refresh(args[1]);
	const [index, total, out] = [Number(args[0]), Number(args[1]), args[2]];
	if (!(index >= 1 && index <= total) || !out) {
		console.error(
			"usage: e2e-shard-list.mjs <index> <total> <out-file> | --refresh [run-id]",
		);
		process.exit(2);
	}
	const timings = JSON.parse(readFileSync(TIMINGS, "utf8"));
	const shard = packShards(listSpecFiles(), timings, total)[index - 1];
	writeFileSync(out, `${shard.files.join("\n")}\n`);
	console.log(
		`Shard ${index} of ${total}: ${shard.files.length} files, about ${Math.round(shard.seconds)} s`,
	);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
