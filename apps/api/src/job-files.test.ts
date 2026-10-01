import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { writeRequestFile } from "./job-files.js";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "job-files-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

test("writeRequestFile writes the request with the given mode and no temp file", async () => {
	await writeRequestFile(dir, { id: "abc" }, 0o640);
	const path = join(dir, "request-abc.json");
	expect(await readFile(path, "utf8")).toBe('{"id":"abc"}\n');
	expect((await stat(path)).mode & 0o777).toBe(0o640);
	expect(await readdir(dir)).toEqual(["request-abc.json"]);
});

test("writeRequestFile honours an owner-only mode", async () => {
	await writeRequestFile(dir, { id: "abc" }, 0o600);
	expect((await stat(join(dir, "request-abc.json"))).mode & 0o777).toBe(0o600);
});

test("writeRequestFile removes its temp file when the rename fails", async () => {
	// A directory at the target path makes the rename fail after the write.
	await mkdir(join(dir, "request-abc.json"));
	await expect(writeRequestFile(dir, { id: "abc" }, 0o600)).rejects.toThrow();
	expect(await readdir(dir)).toEqual(["request-abc.json"]);
});
