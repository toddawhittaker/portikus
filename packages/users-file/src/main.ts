import { runCli } from "./cli.js";
import { defaultUsersFilePath } from "./file.js";

process.exitCode = await runCli(process.argv.slice(2), {
	stdin: process.stdin,
	stdout: process.stdout,
	stderr: process.stderr,
	env: process.env,
	defaultPath: defaultUsersFilePath(),
});
