/**
 * Command line for the account carry-over (docs/EPIC-12B.md):
 *   node carry-over-main.js --input <path> [--apply]
 * Reads DATABASE_URL from the environment. A dry run without --apply.
 */
import { readFileSync } from "node:fs";
import { createDb } from "@portikus/db";
import { carryOver, formatReport, parseCarryOverInput } from "./carry-over.js";

function usage(message: string): never {
	process.stderr.write(`${message}\nusage: carry-over-main --input <path> [--apply]\n`);
	process.exit(2);
}

const args = process.argv.slice(2);
let inputPath: string | undefined;
let apply = false;
for (let i = 0; i < args.length; i++) {
	if (args[i] === "--apply") apply = true;
	else if (args[i] === "--input") inputPath = args[++i];
	else usage(`unknown argument: ${args[i]}`);
}
if (!inputPath) usage("--input is required");
const url = process.env.DATABASE_URL;
if (!url) usage("DATABASE_URL is not set");

const input = parseCarryOverInput(JSON.parse(readFileSync(inputPath, "utf8")));
const db = createDb(url, 1);
try {
	process.stdout.write(formatReport(await carryOver(db, input, { apply })));
} finally {
	await db.destroy();
}
