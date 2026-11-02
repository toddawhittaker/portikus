import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Hold a session on a test's own tmux server so it does not exit when the
 * last terminal closes; a terminal created while it exits fails with
 * "server exited unexpectedly". The workspace's terminals server never
 * exits (SPEC.md §9.7). The name is not pk-*, so no route lists it.
 */
export async function keepTmuxServerAlive(socketName: string): Promise<void> {
	await run("tmux", [
		"-L",
		socketName,
		"new-session",
		"-d",
		"-s",
		"keep-alive",
		"sleep 1d",
	]);
}
