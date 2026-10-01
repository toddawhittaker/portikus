import { open, readdir, readFile } from "node:fs/promises";
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
