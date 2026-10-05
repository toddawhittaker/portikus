/**
 * `portikus alert` runs this as the worker's account with the worker's
 * environment, as `systemd-run` gives it: alert-main.js warning|danger TITLE TEXT.
 */
import { runAlertCommand } from "./alert-command.js";

const code = await runAlertCommand(process.argv.slice(2), process.env, (line) =>
	process.stdout.write(`${line}\n`),
);
// The proxy agent keeps its connection open; nothing else is left to do.
process.exit(code);
