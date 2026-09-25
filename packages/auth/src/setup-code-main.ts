/**
 * Issue a one-time setup code for the first administrator (docs/EPIC-14.md
 * ruling 16): node setup-code-main.js
 * Reads DATABASE_URL from the environment and prints only the code, which
 * Ansible shows to the operator.
 */
import { createDb } from "@portikus/db";
import { issueSetupCode } from "./setup-code.js";

function usage(message: string): never {
	process.stderr.write(`${message}\nusage: setup-code-main\n`);
	process.exit(2);
}

const extra = process.argv[2];
if (extra !== undefined) usage(`unknown argument: ${extra}`);
const url = process.env.DATABASE_URL;
if (!url) usage("DATABASE_URL is not set");

const db = createDb(url, 1);
try {
	process.stdout.write(`${await issueSetupCode(db)}\n`);
} finally {
	await db.destroy();
}
