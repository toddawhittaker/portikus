import {
	open,
	readdir,
	readFile,
	rename,
	rm,
	unlink,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { ZodType } from "zod";

/** log.txt can grow to megabytes during a build; only its tail is read. */
const LOG_TAIL_BYTES = 256 * 1024;

/** Parse a JSON file through `schema`; a missing or malformed file is null. */
export async function readJson<T>(path: string, schema: ZodType<T>): Promise<T | null> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return null;
	}
	try {
		const parsed = schema.safeParse(JSON.parse(text));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

/** The queued or running job, else the one started last. */
export function currentJob<T extends { state: string; startedAt?: string | null }>(
	jobs: T[],
): T | null {
	const active =
		jobs.find((j) => j.state === "running") ?? jobs.find((j) => j.state === "queued");
	if (active) return active;
	const byStart = [...jobs].sort((a, b) =>
		(b.startedAt ?? "").localeCompare(a.startedAt ?? ""),
	);
	return byStart[0] ?? null;
}

export async function listDir(path: string): Promise<string[]> {
	try {
		return await readdir(path);
	} catch {
		return [];
	}
}

/** The last `count` lines of a file, reading at most its last LOG_TAIL_BYTES. */
export async function tailLines(path: string, count: number): Promise<string[]> {
	let data: Buffer;
	try {
		const file = await open(path, "r");
		try {
			const { size } = await file.stat();
			const length = Math.min(size, LOG_TAIL_BYTES);
			data = Buffer.alloc(length);
			const { bytesRead } = await file.read(data, 0, length, size - length);
			data = data.subarray(0, bytesRead);
		} finally {
			await file.close();
		}
	} catch {
		return [];
	}
	const lines = data.toString("utf8").split("\n");
	if (lines.at(-1) === "") lines.pop();
	return lines.slice(-count);
}

/**
 * Write a root helper's request file aside, then rename it, so the helper's
 * path unit never reads half a file. The temp file is removed on failure.
 */
export async function writeRequestFile(
	dir: string,
	file: { id: string },
	mode: number,
): Promise<void> {
	const temp = join(dir, `.request-${file.id}.tmp`);
	try {
		await writeFile(temp, `${JSON.stringify(file)}\n`, { flag: "wx", mode });
		await rename(temp, join(dir, `request-${file.id}.json`));
	} catch (e) {
		await rm(temp, { force: true });
		throw e;
	}
}

/**
 * Remove temp request files a crash left behind; they may hold secrets.
 * Call it under the route's write lock, so no write of ours is in flight.
 */
export async function sweepTempRequests(dir: string): Promise<void> {
	for (const name of await listDir(dir)) {
		if (name.startsWith(".request-") && name.endsWith(".tmp")) {
			await unlink(join(dir, name)).catch(() => {});
		}
	}
}
