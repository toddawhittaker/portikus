/**
 * Command line for ending sessions after `make users-deploy`:
 *   node users-revoke-main.js --input <path>
 * Reads DATABASE_URL from the environment.
 */
import { readFileSync } from "node:fs";
import { createDb } from "@portikus/db";
import {
	formatUsersRevokeReport,
	parseUsersRevokeInput,
	revokeDeployedUsers,
} from "./users-revoke.js";

function usage(message: string): never {
	process.stderr.write(`${message}\nusage: users-revoke-main --input <path>\n`);
	process.exit(2);
}

const args = process.argv.slice(2);
let inputPath: string | undefined;
for (let i = 0; i < args.length; i++) {
	if (args[i] === "--input") inputPath = args[++i];
	else usage(`unknown argument: ${args[i]}`);
}
if (!inputPath) usage("--input is required");
const url = process.env.DATABASE_URL;
if (!url) usage("DATABASE_URL is not set");

const input = parseUsersRevokeInput(JSON.parse(readFileSync(inputPath, "utf8")));
const db = createDb(url, 1);
try {
	process.stdout.write(formatUsersRevokeReport(await revokeDeployedUsers(db, input)));
} finally {
	await db.destroy();
}
