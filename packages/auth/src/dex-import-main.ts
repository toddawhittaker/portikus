/**
 * Command line for the one-time users-file import into Dex (docs/archive/epics/EPIC-14.md ruling 23):
 *   node dex-import-main.js --input <users file> --issuer <Dex issuer URL>
 * Reads DATABASE_URL and DEX_GRPC_ADDR, DEX_GRPC_CA, DEX_GRPC_CERT and
 * DEX_GRPC_KEY from the environment.
 */
import { readFileSync } from "node:fs";
import { createDb } from "@portikus/db";
import { loadDexApi } from "./dex-api.js";
import { formatImportReport, importUsersFile, parseUsersFile } from "./dex-import.js";

function usage(message: string): never {
	process.stderr.write(
		`${message}\nusage: dex-import-main --input <path> --issuer <url>\n`,
	);
	process.exit(2);
}

const args = process.argv.slice(2);
let inputPath: string | undefined;
let issuer: string | undefined;
for (let i = 0; i < args.length; i++) {
	if (args[i] === "--input") inputPath = args[++i];
	else if (args[i] === "--issuer") issuer = args[++i];
	else usage(`unknown argument: ${args[i]}`);
}
if (!inputPath) usage("--input is required");
if (!issuer) usage("--issuer is required");
const url = process.env.DATABASE_URL;
if (!url) usage("DATABASE_URL is not set");

const users = parseUsersFile(JSON.parse(readFileSync(inputPath, "utf8")));
const dex = await loadDexApi({
	DEX_GRPC_ADDR: process.env.DEX_GRPC_ADDR,
	DEX_GRPC_CA: process.env.DEX_GRPC_CA,
	DEX_GRPC_CERT: process.env.DEX_GRPC_CERT,
	DEX_GRPC_KEY: process.env.DEX_GRPC_KEY,
});
if (!dex) usage("DEX_GRPC_ADDR is not set");
const db = createDb(url, 1);
try {
	process.stdout.write(
		formatImportReport(await importUsersFile(db, dex, issuer, users)),
	);
} finally {
	dex.close();
	await db.destroy();
}
