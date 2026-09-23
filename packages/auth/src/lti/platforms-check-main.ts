/**
 * Validate an LTI platforms file before Ansible installs it:
 *   node platforms-check-main.js <path>
 * Exits 0 when the API would accept the file, 1 with the problem on stderr.
 */
import { loadPlatformsFile, PlatformsFileError } from "./platforms.js";

const path = process.argv[2];
if (!path || process.argv.length > 3) {
	process.stderr.write("usage: platforms-check-main <path>\n");
	process.exit(2);
}
try {
	await loadPlatformsFile(path);
} catch (error) {
	if (!(error instanceof PlatformsFileError)) throw error;
	process.stderr.write(`${error.message}\n`);
	process.exit(1);
}
