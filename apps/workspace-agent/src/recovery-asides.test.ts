/**
 * Aside folders (SPEC.md §15.10, §24.6): only a real directory named
 * `.portikus-aside-<uuid>` directly in ~/projects is listed or deleted. A
 * symlink with that name, a near-miss name, or a traversal id is refused,
 * and deleting never reaches through a link inside the folder.
 */
import { randomUUID } from "node:crypto";
import {
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
	ASIDE_WALK_LIMIT,
	asidePointId,
	deleteRecoveryAside,
	listRecoveryAsides,
} from "./recovery-asides.js";

let base: string;
let homeDir: string;
let projects: string;

beforeEach(async () => {
	base = await mkdtemp(join(tmpdir(), "portikus-asides-"));
	homeDir = join(base, "home");
	projects = join(homeDir, "projects");
	await mkdir(join(projects, "alpha"), { recursive: true });
});

afterEach(async () => {
	await rm(base, { recursive: true, force: true });
});

async function makeAside(pointId: string): Promise<string> {
	const path = join(projects, `.portikus-aside-${pointId}`);
	await mkdir(join(path, "src"), { recursive: true });
	await writeFile(join(path, "README.md"), "hello\n");
	await writeFile(join(path, "src", "main.ts"), "x\n");
	return path;
}

test("only the exact name with a uuid counts as an aside folder", () => {
	const id = randomUUID();
	expect(asidePointId(`.portikus-aside-${id}`)).toBe(id);
	expect(asidePointId(`.portikus-aside-${id}x`)).toBeNull();
	expect(asidePointId(`.portikus-aside-${id}/..`)).toBeNull();
	expect(asidePointId(`.portikus-restore-${id}`)).toBeNull();
	expect(asidePointId(`portikus-aside-${id}`)).toBeNull();
	expect(asidePointId(".portikus-aside-")).toBeNull();
	expect(asidePointId(".portikus-aside-../alpha")).toBeNull();
});

test("the list holds each real aside folder with its files and bytes", async () => {
	const id = randomUUID();
	await makeAside(id);
	await symlink("README.md", join(projects, `.portikus-aside-${id}`, "link"));
	const folders = await listRecoveryAsides(homeDir);
	expect(folders).toEqual([
		{
			pointId: id,
			modifiedAt: expect.any(String),
			fileCount: 3,
			sizeBytes: 8,
			complete: true,
		},
	]);
});

test("the list leaves out projects, wrong names, files and symlinks", async () => {
	const outside = join(base, "outside");
	await mkdir(outside);
	await mkdir(join(projects, `.portikus-aside-${randomUUID()}-extra`));
	await mkdir(join(projects, `.portikus-restore-${randomUUID()}`));
	await writeFile(join(projects, `.portikus-aside-${randomUUID()}`), "a file\n");
	await symlink(outside, join(projects, `.portikus-aside-${randomUUID()}`));
	expect(await listRecoveryAsides(homeDir)).toEqual([]);
});

test("no projects folder is an empty list", async () => {
	await rm(projects, { recursive: true });
	expect(await listRecoveryAsides(homeDir)).toEqual([]);
});

test("a folder past the walk limit is reported as incomplete", async () => {
	const id = randomUUID();
	const path = await makeAside(id);
	for (let start = 0; start <= ASIDE_WALK_LIMIT; start += 500) {
		await Promise.all(
			Array.from({ length: 500 }, (_, i) => writeFile(join(path, `f${start + i}`), "")),
		);
	}
	const [folder] = await listRecoveryAsides(homeDir);
	expect(folder?.complete).toBe(false);
	expect(folder?.fileCount).toBeLessThanOrEqual(ASIDE_WALK_LIMIT);
});

test("delete removes the folder and nothing else", async () => {
	const id = randomUUID();
	const other = randomUUID();
	await makeAside(id);
	await makeAside(other);
	await deleteRecoveryAside(homeDir, id);
	expect((await readdir(projects)).sort()).toEqual(
		[`.portikus-aside-${other}`, "alpha"].sort(),
	);
});

test("delete of a folder already gone is not an error", async () => {
	await expect(deleteRecoveryAside(homeDir, randomUUID())).resolves.toBeUndefined();
});

test("delete refuses a symlink with the aside name and leaves its target", async () => {
	const id = randomUUID();
	const target = join(base, "precious");
	await mkdir(target);
	await writeFile(join(target, "keep.txt"), "keep\n");
	const link = join(projects, `.portikus-aside-${id}`);
	await symlink(target, link);
	await expect(deleteRecoveryAside(homeDir, id)).rejects.toMatchObject({
		code: "BAD_REQUEST",
	});
	expect((await lstat(link)).isSymbolicLink()).toBe(true);
	expect(await readFile(join(target, "keep.txt"), "utf8")).toBe("keep\n");
});

test("delete refuses a file with the aside name", async () => {
	const id = randomUUID();
	const file = join(projects, `.portikus-aside-${id}`);
	await writeFile(file, "not a folder\n");
	await expect(deleteRecoveryAside(homeDir, id)).rejects.toMatchObject({
		code: "BAD_REQUEST",
	});
	expect(await readFile(file, "utf8")).toBe("not a folder\n");
});

test("delete refuses an id that is not a uuid, so no traversal reaches a path", async () => {
	for (const id of ["../alpha", "..", "", "alpha", `${randomUUID()}/../../alpha`]) {
		await expect(deleteRecoveryAside(homeDir, id)).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
	}
	expect(await readdir(projects)).toEqual(["alpha"]);
});

test("delete removes a link inside the folder, never what it points at", async () => {
	const id = randomUUID();
	const path = await makeAside(id);
	const target = join(base, "precious");
	await mkdir(target);
	await writeFile(join(target, "keep.txt"), "keep\n");
	await symlink(target, join(path, "escape"));
	await symlink(join(projects, "alpha"), join(path, "project"));
	await deleteRecoveryAside(homeDir, id);
	expect(await readFile(join(target, "keep.txt"), "utf8")).toBe("keep\n");
	expect(await readdir(projects)).toEqual(["alpha"]);
});
