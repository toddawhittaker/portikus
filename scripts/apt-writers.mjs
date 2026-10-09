#!/usr/bin/env node
// Keeps the weekly re-sign and the releases from writing the apt repository
// at the same time. The re-sign has its own concurrency group so it can never
// cancel a waiting release (docs/WORKFLOW.md, "CI"), so the two kinds of run
// keep out of each other's way with these checks instead.
//
// Reads GitHub API JSON on stdin and prints one run id per line.
//   releases <self-id>        release runs (any event but schedule) not yet
//                             finished; input is "list workflow runs"
//   signs <run-id>            prints the run id if that release run will sign
//                             the index; input is "list jobs for a run"
//   resigns <self-id>         re-sign runs (schedule) not yet finished, even
//                             if waiting for approval; input is "list workflow runs"
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const UNFINISHED = new Set([
	"queued",
	"in_progress",
	"waiting",
	"pending",
	"requested",
]);

// Job names from .github/workflows/release.yml.
const GATE_JOB = "Decide whether this push is a release";
const BUILD_JOB = "Build the Debian package";
const APT_JOB = "Sign the apt repository";

export function otherWriters(runs, mode, selfId) {
	return runs
		.filter((run) => String(run.id) !== String(selfId))
		.filter((run) => (mode === "releases") === (run.event !== "schedule"))
		.filter((run) => UNFINISHED.has(run.status))
		.map((run) => run.id);
}

// A release run signs the index only after its gate says release=true and
// its build succeeds. Until the gate has finished nobody knows, so it counts.
// An apt job left "waiting" for environment approval does not count: it may
// wait for weeks, and when approved it waits for any re-sign itself.
export function willSign(jobs) {
	const job = (name) => jobs.find((j) => j.name === name);
	const gate = job(GATE_JOB);
	if (gate?.status !== "completed") return true;
	const build = job(BUILD_JOB);
	if (build && UNFINISHED.has(build.status)) return true;
	const apt = job(APT_JOB);
	return Boolean(apt && UNFINISHED.has(apt.status) && apt.status !== "waiting");
}

function main(args) {
	const [mode, id] = args;
	if (!["releases", "signs", "resigns"].includes(mode) || !id) {
		console.error("usage: apt-writers.mjs releases|signs|resigns <run-id> < api.json");
		process.exit(2);
	}
	const body = JSON.parse(readFileSync(0, "utf8"));
	if (mode === "signs") {
		if (willSign(body.jobs)) console.log(id);
		return;
	}
	for (const run of otherWriters(body.workflow_runs, mode, id)) console.log(run);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
