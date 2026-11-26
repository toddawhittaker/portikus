/** Download names yazl cannot store as they are, and files that vanish mid-download (SPEC.md §11.2). */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const run = promisify(execFile);

/** A file whose name ends so is deleted between the walk and its read. */
const VANISHES = "vanishes.txt";
/** A file whose name ends so cannot be read for another reason. */
const UNREADABLE = "unreadable.txt";

/** A symlink whose name ends so is deleted between its lstat and its readlink. */
const VANISHING_LINK = "vanishes.link";
/** A symlink whose name ends so cannot be read for another reason. */
const UNREADABLE_LINK = "unreadable.link";

vi.mock("node:fs/promises", async (original) => {
	const fs = await original<typeof import("node:fs/promises")>();
	return {
		...fs,
		readlink: (path: string, ...rest: unknown[]) => {
			const fail = (code: string) =>
				Promise.reject(Object.assign(new Error(code), { code }));
			if (String(path).endsWith(VANISHING_LINK)) return fail("ENOENT");
			if (String(path).endsWith(UNREADABLE_LINK)) return fail("EACCES");
			return (fs.readlink as (...args: unknown[]) => Promise<string>)(path, ...rest);
		},
	};
});

vi.mock("node:fs", async (original) => {
	const fs = await original<typeof import("node:fs")>();
	const open = fs.createReadStream as (...args: unknown[]) => unknown;
	return {
		...fs,
		createReadStream: (path: string, ...rest: unknown[]) => {
			// Gone by the time it is opened: a real ENOENT.
			if (path.endsWith(VANISHES)) return open(`${path}.gone`, ...rest);
			// Opens, then fails to read: a real EISDIR.
			if (path.endsWith(UNREADABLE)) return open(tmpdir(), ...rest);
			return open(path, ...rest);
		},
	};
});

const { archiveDir, archiveSelection } = await import("./projects.js");

let root: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "portikus-archive-"));
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

async function collect(stream: Readable): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const chunk of stream) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks);
}

/** The entry names `unzip` lists, after testing the archive. */
async function entries(zip: Buffer): Promise<string[]> {
	const file = join(root, "out.zip");
	await writeFile(file, zip);
	await run("unzip", ["-t", file]);
	const { stdout } = await run("zipinfo", ["-1", file]);
	return stdout.trim().split("\n").sort();
}

test("a name with a backslash or a drive letter is left out, and the rest downloads", async () => {
	const project = join(root, "lab");
	await mkdir(project);
	await writeFile(join(project, "keep.txt"), "kept\n");
	// Beside a symlink `d`, yazl would store `d\authorized_keys` as a path through it.
	await symlink("/home/student/.ssh", join(project, "d"));
	await writeFile(join(project, "d\\authorized_keys"), "ssh-ed25519 AAAA\n");
	// yazl throws on these, which would end every download of the project.
	await writeFile(join(project, "..\\x"), "x\n");
	await mkdir(join(project, "dir\\sub"));
	await writeFile(join(project, "dir\\sub", "inner.txt"), "x\n");

	const zip = await collect(await archiveDir(project, new AbortController().signal));
	expect(await entries(zip)).toEqual(["lab/", "lab/d", "lab/keep.txt"]);
});

test("a selected file named with a drive letter is left out of a selection", async () => {
	const project = join(root, "lab");
	await mkdir(project);
	await writeFile(join(project, "keep.txt"), "kept\n");
	await writeFile(join(project, "C:evil"), "x\n");

	const zip = await collect(
		await archiveSelection(
			[join(project, "keep.txt"), join(project, "C:evil")],
			new AbortController().signal,
		),
	);
	expect(await entries(zip)).toEqual(["keep.txt"]);
});

test("a file deleted between the walk and its read is left out", async () => {
	const project = join(root, "lab");
	await mkdir(project);
	await writeFile(join(project, "keep.txt"), "kept\n");
	await writeFile(join(project, VANISHES), "gone\n");

	const zip = await collect(await archiveDir(project, new AbortController().signal));
	expect(await entries(zip)).toEqual(["lab/", "lab/keep.txt"]);
});

test("any other read error still ends the download", async () => {
	const project = join(root, "lab");
	await mkdir(project);
	await writeFile(join(project, UNREADABLE), "x\n");

	const stream = await archiveDir(project, new AbortController().signal);
	await expect(collect(stream)).rejects.toMatchObject({ code: "EISDIR" });
});

test("a symlink deleted between lstat and readlink is left out", async () => {
	const project = join(root, "lab");
	await mkdir(project);
	await writeFile(join(project, "keep.txt"), "kept\n");
	await symlink("keep.txt", join(project, VANISHING_LINK));

	const zip = await collect(await archiveDir(project, new AbortController().signal));
	expect(await entries(zip)).toEqual(["lab/", "lab/keep.txt"]);
});

test("any other readlink error still ends the download", async () => {
	const project = join(root, "lab");
	await mkdir(project);
	await symlink("keep.txt", join(project, UNREADABLE_LINK));

	await expect(
		archiveDir(project, new AbortController().signal).then(collect),
	).rejects.toMatchObject({ code: "EACCES" });
});
