/**
 * One file of a recovery point against its working copy, with real GNU tar
 * in a temporary home (SPEC.md §15.8, §12.6, §24.6).
 */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { zstdCompressSync } from "node:zlib";
import { MAX_DIFF_SIDE_BYTES } from "@portikus/contracts";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createRecoveryPoint, type RecoveryPaths } from "./recovery.js";
import { recoveryPointDiff } from "./recovery-diff.js";

const run = promisify(execFile);

let base: string;
let paths: RecoveryPaths;
let project: string;
const projectId = randomUUID();

async function sha(file: string): Promise<string> {
	return createHash("sha256")
		.update(await readFile(file))
		.digest("hex");
}

async function makePoint(): Promise<{ pointId: string; sha256: string }> {
	const pointId = randomUUID();
	const made = await createRecoveryPoint(paths, { slug: "alpha", projectId, pointId });
	if (!made.created) throw new Error("no point made");
	return { pointId, sha256: made.sha256 };
}

function diff(pointId: string, sha256: string, path: string, timeoutMs?: number) {
	return recoveryPointDiff(paths, {
		slug: "alpha",
		projectId,
		pointId,
		path,
		sha256,
		...(timeoutMs === undefined ? {} : { timeoutMs }),
	});
}

beforeEach(async () => {
	base = await mkdtemp(join(tmpdir(), "portikus-recovery-diff-"));
	paths = { homeDir: join(base, "home"), recoveryRoot: join(base, "recovery") };
	project = join(paths.homeDir, "projects", "alpha");
	await mkdir(join(project, "src"), { recursive: true });
	await mkdir(paths.recoveryRoot, { mode: 0o700 });
	await writeFile(join(project, "src", "app.js"), "console.log(1);\n");
});

afterEach(async () => {
	await rm(base, { recursive: true, force: true });
});

describe("comparing with a recovery point", () => {
	test("the point's version is before, the working copy after", async () => {
		const { pointId, sha256 } = await makePoint();
		await writeFile(join(project, "src", "app.js"), "console.log(2);\n");
		expect(await diff(pointId, sha256, "src/app.js")).toEqual({
			status: "M",
			before: "console.log(1);\n",
			after: "console.log(2);\n",
			binary: false,
			tooLarge: false,
		});
	});

	test("a file the point does not hold is added", async () => {
		const { pointId, sha256 } = await makePoint();
		await writeFile(join(project, "new.txt"), "new\n");
		const result = await diff(pointId, sha256, "new.txt");
		expect(result).toMatchObject({ status: "A", before: null, after: "new\n" });
	});

	test("a file deleted since, folder and all, is deleted", async () => {
		const { pointId, sha256 } = await makePoint();
		await rm(join(project, "src"), { recursive: true });
		const result = await diff(pointId, sha256, "src/app.js");
		expect(result).toMatchObject({
			status: "D",
			before: "console.log(1);\n",
			after: null,
		});
	});

	test("a file in neither place is not found", async () => {
		const { pointId, sha256 } = await makePoint();
		await expect(diff(pointId, sha256, "nope.txt")).rejects.toMatchObject({
			code: "FILE_NOT_FOUND",
		});
	});

	test("a name is matched literally, never as a wildcard", async () => {
		const { pointId, sha256 } = await makePoint();
		await expect(diff(pointId, sha256, "src/*")).rejects.toMatchObject({
			code: "FILE_NOT_FOUND",
		});
	});

	test("a name that looks like a tar option is only a name", async () => {
		const { pointId, sha256 } = await makePoint();
		await expect(diff(pointId, sha256, "--to-command=id")).rejects.toMatchObject({
			code: "FILE_NOT_FOUND",
		});
	});

	test("a folder is not a file", async () => {
		const { pointId, sha256 } = await makePoint();
		await expect(diff(pointId, sha256, "src")).rejects.toMatchObject({
			code: "PATH_INVALID",
		});
	});

	test.each([
		["../escape.txt"],
		["/etc/passwd"],
		["src/../../escape.txt"],
		["./src/app.js"],
		[""],
		["a\0b"],
	])("refuses the member name %j", async (path) => {
		const { pointId, sha256 } = await makePoint();
		await expect(diff(pointId, sha256, path)).rejects.toMatchObject({
			code: "PATH_INVALID",
		});
	});

	test("refuses a crafted ../ member even when the archive holds it", async () => {
		const pointId = randomUUID();
		const dir = join(paths.recoveryRoot, projectId);
		await mkdir(dir, { mode: 0o700 });
		await writeFile(join(base, "escape.txt"), "OUTSIDE\n");
		const { stdout } = await run("tar", ["-c", "-f", "-", "-P", "../escape.txt"], {
			cwd: paths.homeDir,
			encoding: "buffer",
		});
		const file = join(dir, `${pointId}.tar.zst`);
		await writeFile(file, zstdCompressSync(stdout));
		await expect(diff(pointId, await sha(file), "../escape.txt")).rejects.toMatchObject(
			{ code: "PATH_INVALID" },
		);
	});

	test("an archive that does not match its record returns nothing", async () => {
		const { pointId } = await makePoint();
		await expect(diff(pointId, "0".repeat(64), "src/app.js")).rejects.toMatchObject({
			code: "RECOVERY_POINT_INVALID",
		});
	});

	test("a point that is not there is invalid", async () => {
		await makePoint();
		await expect(
			diff(randomUUID(), "0".repeat(64), "src/app.js"),
		).rejects.toMatchObject({ code: "RECOVERY_POINT_INVALID" });
	});

	test("a side over the cap is too large and carries no content", async () => {
		await writeFile(join(project, "big.txt"), "x".repeat(MAX_DIFF_SIDE_BYTES + 1));
		const { pointId, sha256 } = await makePoint();
		await writeFile(join(project, "big.txt"), "small\n");
		expect(await diff(pointId, sha256, "big.txt")).toEqual({
			status: "M",
			before: null,
			after: null,
			binary: false,
			tooLarge: true,
		});
	});

	test("a read past its time limit says so", async () => {
		const { pointId, sha256 } = await makePoint();
		await expect(diff(pointId, sha256, "src/app.js", 1)).rejects.toMatchObject({
			code: "RECOVERY_READ_TIMEOUT",
		});
	});
});
