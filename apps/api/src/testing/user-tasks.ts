import { readdir, stat } from "node:fs/promises";

// Threads the current user owns; RLIMIT_NPROC counts them, so a busy host can exceed the check cap.
export async function userTaskCount(): Promise<number> {
	const uid = process.getuid?.() ?? 0;
	let count = 0;
	for (const pid of await readdir("/proc")) {
		try {
			if (/^\d+$/.test(pid) && (await stat(`/proc/${pid}`)).uid === uid) {
				count += (await readdir(`/proc/${pid}/task`)).length;
			}
		} catch {
			// The process exited while we looked.
		}
	}
	return count;
}
