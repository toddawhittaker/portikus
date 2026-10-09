#!/usr/bin/env node
// Lists the other Release runs that could write the apt repository at the
// same time as this one. The weekly re-sign has its own concurrency group so
// it can never cancel a waiting release (docs/WORKFLOW.md, "CI"), so
// the two kinds of run keep out of each other's way with this check instead.
//
// Reads the GitHub "list workflow runs" JSON on stdin and prints one run id
// per line.
//   releases <self-id>  release runs (any event but schedule) not yet finished
//   resigns <self-id>   re-sign runs (schedule) that have started
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const UNFINISHED = new Set([
	"queued",
	"in_progress",
	"waiting",
	"pending",
	"requested",
]);

export function otherWriters(runs, mode, selfId) {
	return runs
		.filter((run) => String(run.id) !== String(selfId))
		.filter((run) =>
			mode === "releases"
				? run.event !== "schedule" && UNFINISHED.has(run.status)
				: run.event === "schedule" && run.status === "in_progress",
		)
		.map((run) => run.id);
}

function main(args) {
	const [mode, selfId] = args;
	if ((mode !== "releases" && mode !== "resigns") || !selfId) {
		console.error("usage: apt-writers.mjs releases|resigns <self-run-id> < runs.json");
		process.exit(2);
	}
	const { workflow_runs: runs } = JSON.parse(readFileSync(0, "utf8"));
	for (const id of otherWriters(runs, mode, selfId)) console.log(id);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
