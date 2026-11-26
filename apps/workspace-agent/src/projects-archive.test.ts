import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import {
	appendFile,
	mkdir,
	mkdtemp,
	readlink,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, test } from "vitest";
import { archiveDir, archiveSelection } from "./projects.js";
import { buildServer } from "./server.js";

const run = promisify(execFile);
const TOKEN = "b".repeat(64);

let root: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "portikus-archive-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

async function drain(stream: Readable): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const chunk of stream) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks);
}

/** Write the zip to disk and list its entries with unzip's own tools. */
async function entries(zip: Buffer): Promise<string[]> {
	const path = join(root, "out.zip");
	await writeFile(path, zip);
	await run("unzip", ["-tq", path]);
	const { stdout } = await run("zipinfo", ["-1", path]);
	return stdout.trim().split("\n").sort();
}

test("a folder zips its tree under one top-level entry, empty folders included", async () => {
	const alpha = join(root, "alpha");
	await mkdir(join(alpha, "src", "empty"), { recursive: true });
	await writeFile(join(alpha, "README.md"), "hello\n");
	await writeFile(join(alpha, "src", "a.ts"), "x".repeat(100_000));
	const zip = await drain(await archiveDir(alpha, new AbortController().signal));
	expect(await entries(zip)).toEqual([
		"alpha/",
		"alpha/README.md",
		"alpha/src/",
		"alpha/src/a.ts",
		"alpha/src/empty/",
	]);
	const out = join(root, "x");
	await run("unzip", ["-q", join(root, "out.zip"), "-d", out]);
	expect((await run("cat", [join(out, "alpha", "src", "a.ts")])).stdout).toBe(
		"x".repeat(100_000),
	);
});

test("a folder named - zips its contents", async () => {
	const dash = join(root, "-");
	await mkdir(dash);
	await writeFile(join(dash, "file.txt"), "content\n");
	const zip = await drain(await archiveDir(dash, new AbortController().signal));
	expect(await entries(zip)).toEqual(["-/", "-/file.txt"]);
});

test("symlinks inside and out of the project are stored as links, never followed", async () => {
	const secret = join(root, "secret.txt");
	await writeFile(secret, "TOP-SECRET-OUTSIDE\n");
	const alpha = join(root, "alpha");
	await mkdir(alpha);
	await writeFile(join(alpha, "file.txt"), "content\n");
	await symlink("file.txt", join(alpha, "inside.link"));
	await symlink(secret, join(alpha, "outside.link"));
	await symlink(root, join(alpha, "outside-dir.link"));

	const zip = await drain(await archiveDir(alpha, new AbortController().signal));
	// The outside file's bytes never enter the archive (SPEC.md §24.6).
	expect(zip.includes("TOP-SECRET-OUTSIDE")).toBe(false);
	expect(await entries(zip)).toEqual([
		"alpha/",
		"alpha/file.txt",
		"alpha/inside.link",
		"alpha/outside-dir.link",
		"alpha/outside.link",
	]);
	const out = join(root, "x");
	await run("unzip", ["-q", join(root, "out.zip"), "-d", out]);
	expect(await readlink(join(out, "alpha", "inside.link"))).toBe("file.txt");
	expect(await readlink(join(out, "alpha", "outside.link"))).toBe(secret);
	expect(await readlink(join(out, "alpha", "outside-dir.link"))).toBe(root);
});

test("a selected symlink is stored as the link itself", async () => {
	const alpha = join(root, "alpha");
	await mkdir(alpha);
	await writeFile(join(root, "secret.txt"), "TOP-SECRET-OUTSIDE\n");
	await writeFile(join(alpha, "a.txt"), "a\n");
	await symlink(join(root, "secret.txt"), join(alpha, "out.link"));
	const zip = await drain(
		await archiveSelection(
			[join(alpha, "a.txt"), join(alpha, "out.link")],
			new AbortController().signal,
		),
	);
	expect(zip.includes("TOP-SECRET-OUTSIDE")).toBe(false);
	expect(await entries(zip)).toEqual(["a.txt", "out.link"]);
});

test("a file that changes size mid-download fails the stream instead of ending it", async () => {
	const alpha = join(root, "alpha");
	await mkdir(alpha);
	// The large first file holds the stream back, so the second is read only later.
	await writeFile(join(alpha, "a.bin"), randomBytes(8 * 1024 * 1024));
	await writeFile(join(alpha, "grows.txt"), "short\n");
	const stream = await archiveDir(alpha, new AbortController().signal);
	await once(stream, "readable");
	await appendFile(join(alpha, "grows.txt"), "x".repeat(10_000));
	await expect(drain(stream)).rejects.toThrow(/unexpected number of bytes/);
});

test("aborting the signal fails the stream and stops the walk", async () => {
	const alpha = join(root, "alpha");
	await mkdir(alpha);
	for (let i = 0; i < 50; i++)
		await writeFile(join(alpha, `f${i}`), "x".repeat(50_000));
	const controller = new AbortController();
	const stream = await archiveDir(alpha, controller.signal);
	stream.once("data", () => controller.abort());
	await expect(drain(stream)).rejects.toThrow(/aborted/);
	expect(stream.destroyed).toBe(true);
});

test("over HTTP, the zip's first bytes arrive and a failure mid-stream aborts the response", async () => {
	const homeDir = join(root, "home");
	const project = join(homeDir, "projects", "alpha");
	await mkdir(project, { recursive: true });
	await writeFile(join(project, "a.bin"), randomBytes(8 * 1024 * 1024));
	await writeFile(join(project, "b.txt"), "short\n");
	const tokenPath = join(homeDir, "agent.token");
	await writeFile(tokenPath, `${TOKEN}\n`, { mode: 0o600 });
	const app = buildServer({ tmuxSocketName: "portikus-test", tokenPath, homeDir });
	const address = await app.listen({ host: "127.0.0.1", port: 0 });
	try {
		const ok = await fetch(`${address}/projects/alpha/archive`, {
			headers: { authorization: `Bearer ${TOKEN}` },
		});
		expect(ok.status).toBe(200);
		expect(ok.headers.get("content-type")).toContain("application/zip");
		expect(await entries(Buffer.from(await ok.arrayBuffer()))).toEqual([
			"alpha/",
			"alpha/a.bin",
			"alpha/b.txt",
		]);

		const response = await fetch(`${address}/projects/alpha/archive`, {
			headers: { authorization: `Bearer ${TOKEN}` },
		});
		expect(response.status).toBe(200);
		// The headers are out; now the second file grows past its recorded size.
		await appendFile(join(project, "b.txt"), "x".repeat(10_000));
		await expect(response.arrayBuffer()).rejects.toThrow();
	} finally {
		await app.close();
	}
});
