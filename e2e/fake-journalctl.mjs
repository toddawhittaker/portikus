#!/usr/bin/env node
// Stands in for journalctl in e2e and route tests (docs/adr/0036). Each line
// of FAKE_JOURNAL_FILE is one entry of portikus-api.service, as the API's
// standard output would reach the journal. It honours the arguments the API
// passes: --unit, --reverse, --since, --until, --after-cursor and --grep.
import { readFileSync } from "node:fs";

const ZEROS = "0".repeat(32);
const args = process.argv.slice(2);
const value = (name) =>
	args
		.filter((arg) => arg.startsWith(`--${name}=`))
		.map((arg) => arg.slice(name.length + 3));

let text = "";
try {
	text = readFileSync(process.env.FAKE_JOURNAL_FILE ?? "", "utf8");
} catch {
	// No file yet: an empty journal.
}

let lastMicros = 0n;
const entries = text
	.split("\n")
	.filter((line) => line !== "")
	.map((line, index) => {
		try {
			const time = Date.parse(JSON.parse(line).time);
			if (!Number.isNaN(time)) lastMicros = BigInt(time) * 1000n;
		} catch {
			// Not JSON: keeps the previous line's time.
		}
		return {
			index,
			micros: lastMicros,
			unit: "portikus-api.service",
			message: line,
		};
	});

const units = value("unit");
const since = value("since")[0];
const until = value("until")[0];
const after = value("after-cursor")[0];
const grep = value("grep")[0];
const reverse = args.includes("--reverse");
const micros = (at) => BigInt(at.slice(1)) * 1_000_000n;

let selected = entries.filter(
	(entry) =>
		(units.length === 0 || units.includes(entry.unit)) &&
		(!since || entry.micros >= micros(since)) &&
		(!until || entry.micros <= micros(until)) &&
		(!grep || new RegExp(grep, "i").test(entry.message)),
);
if (reverse) selected.reverse();
if (after) {
	const index = Number.parseInt(/;i=([0-9a-f]+);/.exec(after)?.[1] ?? "", 16);
	selected = selected.filter((entry) =>
		reverse ? entry.index < index : entry.index > index,
	);
}

for (const entry of selected) {
	const cursor = `s=${ZEROS};i=${entry.index.toString(16)};b=${ZEROS};m=0;t=${entry.micros.toString(16)};x=0`;
	process.stdout.write(
		`${JSON.stringify({
			__CURSOR: cursor,
			__REALTIME_TIMESTAMP: entry.micros.toString(),
			_SYSTEMD_UNIT: entry.unit,
			MESSAGE: entry.message,
		})}\n`,
	);
}
// Like journalctl, --grep with no match exits 1.
process.exitCode = grep && selected.length === 0 ? 1 : 0;
