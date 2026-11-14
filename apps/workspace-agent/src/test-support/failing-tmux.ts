import { execFile } from "node:child_process";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Put a `tmux` first on PATH that fails any call whose arguments contain
 * `fail` and runs the real tmux for every other call. Returns a function
 * that puts PATH back.
 */
export async function failingTmux(fail: string): Promise<() => void> {
	const real = (await run("sh", ["-c", "command -v tmux"])).stdout.trim();
	const dir = await mkdtemp(join(tmpdir(), "pk-tmux-shim-"));
	const script = join(dir, "tmux");
	await writeFile(
		script,
		`#!/bin/sh\ncase " $* " in *'${fail}'*) echo "refused by the test" >&2; exit 1;; esac\nexec '${real}' "$@"\n`,
	);
	await chmod(script, 0o755);
	const path = process.env.PATH;
	process.env.PATH = `${dir}:${path ?? ""}`;
	return () => {
		process.env.PATH = path;
	};
}
