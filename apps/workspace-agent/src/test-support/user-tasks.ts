import { readdir, stat } from "node:fs/promises";

/**
 * Every task (thread) the current user owns, which is what RLIMIT_NPROC
 * counts. A busy dev host can be over the production check cap on its own,
 * so tests that start a real check set the cap from this.
 */
export async function userTaskCount(): Promise<number> {
	const uid = process.getuid?.() ?? 0;
	let count = 0;
	for (const entry of await readdir("/proc")) {
		if (!/^\d+$/.test(entry)) continue;
		try {
			if ((await stat(`/proc/${entry}`)).uid !== uid) continue;
			count += (await readdir(`/proc/${entry}/task`)).length;
		} catch {
			// The process exited while we looked.
		}
	}
	return count;
}
