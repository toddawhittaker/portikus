/**
 * `portikus backup-channel pull|report` runs this as the portikus user with the
 * worker's environment (SPEC.md §24.9; ADR 0024, ADR 0040):
 *   pull    prints at most one claimed request as one JSON line
 *   report  reads the host's report document on standard input
 * Exit 0 on success, 2 for a usage error or a refused report, 1 otherwise.
 */
import { BACKUP_REPORT_MAX_BYTES } from "@portikus/contracts";
import { createDb } from "@portikus/db";
import { acceptReport, pullRequest } from "./backups.js";

/** Read standard input, stopping one byte past the cap so an oversize is seen. */
async function readInput(): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of process.stdin) {
		chunks.push(chunk as Buffer);
		size += (chunk as Buffer).length;
		if (size > BACKUP_REPORT_MAX_BYTES) break;
	}
	return Buffer.concat(chunks);
}

const command = process.argv[2];
const url = process.env.DATABASE_URL;
if (command !== "pull" && command !== "report") {
	process.stderr.write("usage: backup-channel-main.js pull|report\n");
	process.exit(2);
}
if (!url) {
	process.stderr.write("DATABASE_URL must be set\n");
	process.exit(2);
}
const db = createDb(url, 1);
let code = 1;
try {
	if (command === "pull") {
		const request = await pullRequest(db, new Date());
		if (request) process.stdout.write(`${JSON.stringify(request)}\n`);
		code = 0;
	} else {
		const outcome = await acceptReport(db, await readInput(), new Date());
		if (outcome.ok) {
			if (outcome.warning) process.stderr.write(`${outcome.warning}\n`);
			code = 0;
		} else {
			process.stderr.write(`refused: ${outcome.error}\n`);
			code = 2;
		}
	}
} catch (error) {
	process.stderr.write(
		`backup-channel ${command} failed: ${(error as Error).message}\n`,
	);
} finally {
	await db.destroy();
}
process.exit(code);
