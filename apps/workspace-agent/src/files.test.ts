import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile as readFileFs,
	readlink,
	rm,
	stat,
	symlink,
	truncate,
	writeFile as writeFileFs,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import {
	MAX_DOWNLOAD_BYTES,
	MAX_EDITOR_FILE_BYTES,
	MAX_TREE_ENTRIES,
	MAX_UPLOAD_BYTES,
} from "@portikus/contracts";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { writeFile as writeFileLib } from "./files.js";
import { buildServer } from "./server.js";

const run = promisify(execFile);

const TOKEN = "b".repeat(64);

let app: FastifyInstance;
let homeDir: string;
let projectsRoot: string;
let project: string;

async function available(command: string, args: string[]): Promise<boolean> {
	try {
		await run(command, args);
		return true;
	} catch {
		return false;
	}
}

const haveZip = (await available("zip", ["-v"])) && (await available("unzip", ["-v"]));
const haveMkfifo = await available("mkfifo", ["--version"]);

function auth() {
	return { authorization: `Bearer ${TOKEN}` };
}

function sha256(content: string | Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

beforeAll(async () => {
	homeDir = await mkdtemp(join(tmpdir(), "portikus-files-"));
	projectsRoot = join(homeDir, "projects");
	const tokenPath = join(homeDir, "agent.token");
	await writeFileFs(tokenPath, `${TOKEN}\n`, { mode: 0o600 });
	app = buildServer({ tokenPath, homeDir });
	await app.ready();
});

afterAll(async () => {
	await app.close();
	await rm(homeDir, { recursive: true, force: true });
});

beforeEach(async () => {
	await rm(projectsRoot, { recursive: true, force: true });
	project = join(projectsRoot, "alpha");
	await mkdir(project, { recursive: true });
	await mkdir(join(projectsRoot, "beta"), { recursive: true });
	await writeFileFs(join(projectsRoot, "beta", "secret.txt"), "sibling");
	await writeFileFs(join(homeDir, "outside.txt"), "outside");
});

function tree(path: string) {
	return app.inject({
		method: "GET",
		url: `/projects/alpha/tree?path=${encodeURIComponent(path)}`,
		headers: auth(),
	});
}

function readFile(path: string, query = "") {
	return app.inject({
		method: "GET",
		url: `/projects/alpha/file?path=${encodeURIComponent(path)}${query}`,
		headers: auth(),
	});
}

function writeFile(
	path: string,
	body: string | Buffer,
	headers: Record<string, string>,
) {
	return app.inject({
		method: "PUT",
		url: `/projects/alpha/file?path=${encodeURIComponent(path)}`,
		headers: { ...auth(), "content-type": "text/plain", ...headers },
		payload: body,
	});
}

function deleteFile(path: string) {
	return app.inject({
		method: "DELETE",
		url: `/projects/alpha/file?path=${encodeURIComponent(path)}`,
		headers: auth(),
	});
}

// --- SPEC.md §24.6: every escape fails closed -----------------------------

const ESCAPES: Array<[string, string]> = [
	["a .. segment", "../beta/secret.txt"],
	["a nested .. segment", "sub/../../beta/secret.txt"],
	["an absolute path", "/etc/passwd"],
	["a backslash", "sub\\..\\..\\beta"],
	["a . segment", "./notes.txt"],
];

for (const [name, path] of ESCAPES) {
	test(`reading refuses ${name}`, async () => {
		const response = await readFile(path);
		expect(response.statusCode).toBe(400);
		expect(response.json().error.code).toBe("PATH_INVALID");
	});

	test(`writing refuses ${name}`, async () => {
		const response = await writeFile(path, "x", { "if-none-match": "*" });
		expect(response.statusCode).toBe(400);
		expect(response.json().error.code).toBe("PATH_INVALID");
	});
}

test("a NUL byte in the path is refused", async () => {
	const response = await app.inject({
		method: "GET",
		url: "/projects/alpha/file?path=notes%00.txt",
		headers: auth(),
	});
	expect(response.statusCode).toBe(400);
	expect(response.json().error.code).toBe("PATH_INVALID");
});

test("a symlink pointing outside the projects directory is refused", async () => {
	await symlink(join(homeDir, "outside.txt"), join(project, "escape.txt"));

	expect((await readFile("escape.txt")).json().error.code).toBe("PATH_INVALID");
	expect(
		(await writeFile("escape.txt", "x", { "if-match": sha256("outside") })).json().error
			.code,
	).toBe("PATH_INVALID");
	// The target is still there: nothing followed the link.
	expect(await readFileFs(join(homeDir, "outside.txt"), "utf8")).toBe("outside");
});

test("a symlink pointing at a sibling project is refused", async () => {
	await symlink(join(projectsRoot, "beta", "secret.txt"), join(project, "peek.txt"));
	const response = await readFile("peek.txt");
	expect(response.statusCode).toBe(400);
	expect(response.json().error.code).toBe("PATH_INVALID");
});

test("a symlinked directory in the middle of the path is refused", async () => {
	await symlink(join(projectsRoot, "beta"), join(project, "link"));
	const response = await readFile("link/secret.txt");
	expect(response.statusCode).toBe(400);
	expect(response.json().error.code).toBe("PATH_INVALID");
});

test("a move whose target escapes, or already exists, is refused", async () => {
	await writeFileFs(join(project, "a.txt"), "a");
	await writeFileFs(join(project, "b.txt"), "b");

	const escaping = await app.inject({
		method: "POST",
		url: "/projects/alpha/move",
		headers: auth(),
		payload: { from: "a.txt", to: "../beta/stolen.txt" },
	});
	expect(escaping.statusCode).toBe(400);
	expect(escaping.json().error.code).toBe("PATH_INVALID");

	const existing = await app.inject({
		method: "POST",
		url: "/projects/alpha/move",
		headers: auth(),
		payload: { from: "a.txt", to: "b.txt" },
	});
	expect(existing.statusCode).toBe(409);
	expect(existing.json().error.code).toBe("FILE_EXISTS");
	expect(await readFileFs(join(project, "b.txt"), "utf8")).toBe("b");
});

// --- Reads ----------------------------------------------------------------

test("a text file comes back with its etag and content type", async () => {
	await writeFileFs(join(project, "notes.txt"), "hello");
	const response = await readFile("notes.txt");
	expect(response.statusCode).toBe(200);
	expect(response.body).toBe("hello");
	expect(response.headers.etag).toBe(sha256("hello"));
	expect(response.headers["content-type"]).toBe("text/plain; charset=utf-8");
});

test("a NUL byte in the first 8 KiB makes the file binary", async () => {
	await writeFileFs(join(project, "blob.bin"), Buffer.from([1, 2, 0, 3]));
	const response = await readFile("blob.bin");
	expect(response.headers["content-type"]).toBe("application/octet-stream");
});

test("a file past the editor limit is refused unless it is a download", async () => {
	const big = Buffer.alloc(MAX_EDITOR_FILE_BYTES + 1, 0x61);
	await writeFileFs(join(project, "big.txt"), big);

	const editor = await readFile("big.txt");
	expect(editor.statusCode).toBe(413);
	expect(editor.json().error.code).toBe("FILE_TOO_LARGE");

	const download = await readFile("big.txt", "&download=1");
	expect(download.statusCode).toBe(200);
	expect(download.rawPayload.length).toBe(big.length);
	expect(download.headers["content-disposition"]).toBe(
		"attachment; filename=\"big.txt\"; filename*=UTF-8''big.txt",
	);
});

test("a file past the download cap is refused before any byte is sent (#399)", async () => {
	// A sparse file has the apparent size without using the disk.
	await writeFileFs(join(project, "huge.bin"), "");
	await truncate(join(project, "huge.bin"), MAX_DOWNLOAD_BYTES + 1);
	const download = await readFile("huge.bin", "&download=1");
	expect(download.statusCode).toBe(413);
	expect(download.json().error.code).toBe("FILE_TOO_LARGE");
});

test("reading a directory is a bad request and a missing file is a 404", async () => {
	await mkdir(join(project, "src"));
	expect((await readFile("src")).statusCode).toBe(400);
	const missing = await readFile("nope.txt");
	expect(missing.statusCode).toBe(404);
	expect(missing.json().error.code).toBe("FILE_NOT_FOUND");
});

// --- Writes ---------------------------------------------------------------

test("a create over an existing file is a conflict", async () => {
	const created = await writeFile("notes.txt", "hello", { "if-none-match": "*" });
	expect(created.statusCode).toBe(200);
	expect(created.json()).toEqual({ etag: sha256("hello"), size: 5 });

	const again = await writeFile("notes.txt", "other", { "if-none-match": "*" });
	expect(again.statusCode).toBe(409);
	expect(again.json().error.code).toBe("FILE_EXISTS");
	expect(await readFileFs(join(project, "notes.txt"), "utf8")).toBe("hello");
});

test("a stale etag is a 412 that carries the current etag", async () => {
	await writeFileFs(join(project, "notes.txt"), "current");
	const response = await writeFile("notes.txt", "stale write", {
		"if-match": `"${sha256("old")}"`,
	});
	expect(response.statusCode).toBe(412);
	expect(response.json().error.code).toBe("FILE_CHANGED");
	expect(response.headers.etag).toBe(sha256("current"));
	expect(await readFileFs(join(project, "notes.txt"), "utf8")).toBe("current");
});

test("a matching etag writes and returns the new etag", async () => {
	await writeFileFs(join(project, "notes.txt"), "one");
	const response = await writeFile("notes.txt", "two", { "if-match": sha256("one") });
	expect(response.statusCode).toBe(200);
	expect(response.headers.etag).toBe(sha256("two"));
	expect(await readFileFs(join(project, "notes.txt"), "utf8")).toBe("two");
});

test("a write needs exactly one condition", async () => {
	const none = await writeFile("notes.txt", "x", {});
	expect(none.statusCode).toBe(400);
	const both = await writeFile("notes.txt", "x", {
		"if-match": sha256("x"),
		"if-none-match": "*",
	});
	expect(both.statusCode).toBe(400);
});

test("an editor write past the limit is refused and leaves nothing behind", async () => {
	const body = Buffer.alloc(MAX_EDITOR_FILE_BYTES + 1, 0x61);
	const response = await writeFile("big.txt", body, { "if-none-match": "*" });
	expect(response.statusCode).toBe(413);
	expect(response.json().error.code).toBe("FILE_TOO_LARGE");
	expect(await readdir(project)).not.toContain("big.txt");
});

test("an upload past the editor limit is accepted", async () => {
	const body = Buffer.alloc(MAX_EDITOR_FILE_BYTES + 1, 0x61);
	const response = await app.inject({
		method: "PUT",
		url: "/projects/alpha/file?path=upload.bin",
		headers: {
			...auth(),
			"content-type": "application/octet-stream",
			"if-none-match": "*",
		},
		payload: body,
	});
	expect(response.statusCode).toBe(200);
	expect(response.json().size).toBe(body.length);
});

// --- Tree, mkdir, delete --------------------------------------------------

test("directories sort before files and symlinks report themselves", async () => {
	await mkdir(join(project, "zeta"));
	await mkdir(join(project, "alpha-dir"));
	await writeFileFs(join(project, "a.txt"), "a");
	await writeFileFs(join(project, "b.txt"), "b");
	await symlink(join(homeDir, "outside.txt"), join(project, "link"));

	const response = await tree("");
	expect(response.statusCode).toBe(200);
	const body = response.json();
	expect(body.truncated).toBe(false);
	expect(body.entries.map((entry: { name: string }) => entry.name)).toEqual([
		"alpha-dir",
		"zeta",
		"a.txt",
		"b.txt",
		"link",
	]);
	expect(
		body.entries.find((entry: { name: string }) => entry.name === "link").type,
	).toBe("symlink");
});

test("a directory past the cap is truncated", async () => {
	const many = join(project, "many");
	await mkdir(many);
	await Promise.all(
		Array.from({ length: MAX_TREE_ENTRIES + 1 }, (_, index) =>
			writeFileFs(join(many, `f${String(index).padStart(5, "0")}.txt`), ""),
		),
	);
	const body = (await tree("many")).json();
	expect(body.entries).toHaveLength(MAX_TREE_ENTRIES);
	expect(body.truncated).toBe(true);
});

test("mkdir creates a directory and refuses a name already taken", async () => {
	const created = await app.inject({
		method: "POST",
		url: "/projects/alpha/mkdir",
		headers: auth(),
		payload: { path: "src/inner" },
	});
	// The parent does not exist yet, so this fails.
	expect(created.statusCode).toBe(404);

	await app.inject({
		method: "POST",
		url: "/projects/alpha/mkdir",
		headers: auth(),
		payload: { path: "src" },
	});
	expect(await readdir(project)).toContain("src");

	const again = await app.inject({
		method: "POST",
		url: "/projects/alpha/mkdir",
		headers: auth(),
		payload: { path: "src" },
	});
	expect(again.statusCode).toBe(409);
});

test("delete removes a file and a directory tree", async () => {
	await writeFileFs(join(project, "a.txt"), "a");
	await mkdir(join(project, "src", "deep"), { recursive: true });
	await writeFileFs(join(project, "src", "deep", "b.txt"), "b");

	expect((await deleteFile("a.txt")).statusCode).toBe(204);
	expect((await deleteFile("src")).statusCode).toBe(204);
	expect(await readdir(project)).toEqual([]);
});

test("deleting with no path cannot remove the project itself", async () => {
	const response = await deleteFile("");
	expect(response.statusCode).toBe(400);
	expect(response.json().error.code).toBe("PATH_INVALID");
	expect(await readdir(projectsRoot)).toContain("alpha");
});

test("move renames within the project", async () => {
	await writeFileFs(join(project, "a.txt"), "a");
	const response = await app.inject({
		method: "POST",
		url: "/projects/alpha/move",
		headers: auth(),
		payload: { from: "a.txt", to: "b.txt" },
	});
	expect(response.statusCode).toBe(204);
	expect(await readFileFs(join(project, "b.txt"), "utf8")).toBe("a");
});

// --- Archive --------------------------------------------------------------

test.skipIf(!haveZip)(
	"a subdirectory archive is named after that directory",
	async () => {
		await mkdir(join(project, "src"));
		await writeFileFs(join(project, "src", "main.ts"), "hi");
		await writeFileFs(join(project, "top.txt"), "top");

		const response = await app.inject({
			method: "GET",
			url: "/projects/alpha/archive?path=src",
			headers: auth(),
		});
		expect(response.statusCode).toBe(200);
		const zipPath = join(homeDir, "sub.zip");
		await writeFileFs(zipPath, response.rawPayload);
		const { stdout } = await run("unzip", ["-Z1", zipPath]);
		const names = stdout.trim().split("\n").sort();
		expect(names).toEqual(["src/", "src/main.ts"]);
		await rm(zipPath, { force: true });
	},
);

test("an archive of a path that escapes is refused", async () => {
	const response = await app.inject({
		method: "GET",
		url: "/projects/alpha/archive?path=..%2Fbeta",
		headers: auth(),
	});
	expect(response.statusCode).toBe(400);
	expect(response.json().error.code).toBe("PATH_INVALID");
});

// --- SPEC.md §24.6: writes never follow a final symlink -------------------

async function tempLeftovers(dir: string): Promise<string[]> {
	return (await readdir(dir)).filter((name) => name.includes(".portikus-"));
}

test("a create through a dangling symlink cannot write outside the project", async () => {
	await symlink(join(homeDir, "gone.txt"), join(project, "evil.txt"));
	const response = await writeFile("evil.txt", "pwned", { "if-none-match": "*" });
	expect(response.statusCode).toBe(400);
	expect(response.json().error.code).toBe("PATH_INVALID");
	await expect(readFileFs(join(homeDir, "gone.txt"), "utf8")).rejects.toThrow();
	expect(await tempLeftovers(project)).toEqual([]);
});

test("an over-cap write through a symlink leaves the outside file alone", async () => {
	await symlink(join(homeDir, "outside.txt"), join(project, "evil.txt"));
	const body = Buffer.alloc(MAX_EDITOR_FILE_BYTES + 1, 0x61);
	const response = await writeFile("evil.txt", body, { "if-none-match": "*" });
	expect(response.statusCode).toBe(400);
	expect(await readFileFs(join(homeDir, "outside.txt"), "utf8")).toBe("outside");
	expect(await tempLeftovers(project)).toEqual([]);
});

// --- SPEC.md §13.5: a failed save never loses the file --------------------

test("an over-cap write leaves the existing file intact", async () => {
	await writeFileFs(join(project, "notes.txt"), "keep me");
	const body = Buffer.alloc(3 * 1024 * 1024, 0x61);
	const response = await writeFile("notes.txt", body, {
		"if-match": sha256("keep me"),
	});
	expect(response.statusCode).toBe(413);
	expect(response.json().error.code).toBe("FILE_TOO_LARGE");
	expect(await readFileFs(join(project, "notes.txt"), "utf8")).toBe("keep me");
	expect(await tempLeftovers(project)).toEqual([]);
});

test("a body stream that fails mid-write leaves the existing file intact", async () => {
	await writeFileFs(join(project, "notes.txt"), "keep me");
	const failing = new Readable({
		read() {
			this.push("part");
			this.destroy(new Error("the client went away"));
		},
	});
	await expect(
		writeFileLib(homeDir, "alpha", "notes.txt", failing, {
			ifMatch: sha256("keep me"),
		}),
	).rejects.toThrow();
	expect(await readFileFs(join(project, "notes.txt"), "utf8")).toBe("keep me");
	expect(await tempLeftovers(project)).toEqual([]);
});

test("If-Match: * replaces any existing file, and only an existing one", async () => {
	await writeFileFs(join(project, "notes.txt"), "old");
	const replaced = await writeFile("notes.txt", "new", { "if-match": "*" });
	expect(replaced.statusCode).toBe(200);
	expect(await readFileFs(join(project, "notes.txt"), "utf8")).toBe("new");

	const missing = await writeFile("gone.txt", "new", { "if-match": "*" });
	expect(missing.statusCode).toBe(404);
	expect(missing.json().error.code).toBe("FILE_NOT_FOUND");
});

test("a write keeps the existing file's mode", async () => {
	const script = join(project, "run.sh");
	await writeFileFs(script, "old", { mode: 0o755 });
	const response = await writeFile("run.sh", "new", { "if-match": sha256("old") });
	expect(response.statusCode).toBe(200);
	expect((await stat(script)).mode & 0o777).toBe(0o755);
});

// --- Content types and body limits ----------------------------------------

test("a JSON content type is written as raw bytes", async () => {
	const payload = '{"emoji":"héllo ☃"}';
	const response = await writeFile("data.json", payload, {
		"content-type": "application/json",
		"if-none-match": "*",
	});
	expect(response.statusCode).toBe(200);
	expect(response.json().size).toBe(Buffer.byteLength(payload));
	expect(await readFileFs(join(project, "data.json"), "utf8")).toBe(payload);
});

test("a text/plain charset content type is written as raw bytes", async () => {
	const payload = "naïve ☃ snowman";
	const response = await writeFile("note.txt", payload, {
		"content-type": "text/plain; charset=utf-8",
		"if-none-match": "*",
	});
	expect(response.statusCode).toBe(200);
	expect(response.json().size).toBe(Buffer.byteLength(payload));
	expect(await readFileFs(join(project, "note.txt"), "utf8")).toBe(payload);
});

test("a huge JSON body to mkdir is refused by the body limit", async () => {
	const response = await app.inject({
		method: "POST",
		url: "/projects/alpha/mkdir",
		headers: { ...auth(), "content-type": "application/json" },
		payload: JSON.stringify({ path: "a".repeat(3 * 1024 * 1024) }),
	});
	expect(response.statusCode).toBe(413);
});

// --- Download names and listing -------------------------------------------

test("a download name drops control characters and carries an encoded form", async () => {
	const name = "bad\r\nname ☃.txt";
	await writeFileFs(join(project, name), "hi");
	const response = await readFile(name, "&download=1");
	expect(response.statusCode).toBe(200);
	const disposition = response.headers["content-disposition"] as string;
	expect(disposition).not.toMatch(/[\r\n]/);
	expect(disposition).toContain('filename="badname _.txt"');
	expect(disposition).toContain("filename*=UTF-8''bad");
	expect(disposition).toContain("%E2%98%83");
});

// --- SPEC.md §13.5: a create never overwrites what appeared meanwhile ------

test("a create whose target appears during the upload is a conflict", async () => {
	const target = join(project, "race.txt");
	const body = new Readable({
		read() {
			// The file lands after the existence check and before the link.
			writeFileSync(target, "winner");
			this.push("loser");
			this.push(null);
		},
	});
	await expect(
		writeFileLib(homeDir, "alpha", "race.txt", body, { ifNoneMatch: true }),
	).rejects.toMatchObject({ code: "FILE_EXISTS" });
	expect(await readFileFs(target, "utf8")).toBe("winner");
	expect(await tempLeftovers(project)).toEqual([]);
});

test("a name of 240 characters can still be written", async () => {
	const name = `${"n".repeat(236)}.txt`;
	const response = await writeFile(name, "hi", { "if-none-match": "*" });
	expect(response.statusCode).toBe(200);
	expect(await readFileFs(join(project, name), "utf8")).toBe("hi");
	expect(await tempLeftovers(project)).toEqual([]);
});

test("an upload past the upload cap is refused and leaves nothing behind", async () => {
	let sent = 0;
	const body = new Readable({
		read() {
			if (sent > MAX_UPLOAD_BYTES) {
				this.push(null);
				return;
			}
			sent += 1024 * 1024;
			this.push(Buffer.alloc(1024 * 1024, 0x61));
		},
	});
	await expect(
		writeFileLib(homeDir, "alpha", "huge.bin", body, {
			ifNoneMatch: true,
			upload: true,
		}),
	).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
	expect(await readdir(project)).not.toContain("huge.bin");
	expect(await tempLeftovers(project)).toEqual([]);
});

test("an upload is allowed past the editor cap by the query flag alone", async () => {
	const body = Buffer.alloc(MAX_EDITOR_FILE_BYTES + 1, 0x61);
	const response = await app.inject({
		method: "PUT",
		url: "/projects/alpha/file?path=upload.bin&upload=1",
		headers: { ...auth(), "content-type": "text/plain", "if-none-match": "*" },
		payload: body,
	});
	expect(response.statusCode).toBe(200);
	expect(response.json().size).toBe(body.length);
});

// --- SPEC.md §24.6: a symlink can be removed, never followed --------------

test("a symlink out of the project is deleted as a link", async () => {
	await symlink(join(homeDir, "outside.txt"), join(project, "escape.txt"));
	expect((await deleteFile("escape.txt")).statusCode).toBe(204);
	expect(await readdir(project)).toEqual([]);
	expect(await readFileFs(join(homeDir, "outside.txt"), "utf8")).toBe("outside");
});

test("a link to a system file is deleted without touching that file", async () => {
	await symlink("/etc/passwd", join(project, "passwd"));
	expect((await deleteFile("passwd")).statusCode).toBe(204);
	expect(await readdir(project)).toEqual([]);
	expect((await stat("/etc/passwd")).isFile()).toBe(true);
});

test("a dangling symlink can be deleted and renamed", async () => {
	await symlink(join(homeDir, "gone.txt"), join(project, "dangling"));
	const moved = await app.inject({
		method: "POST",
		url: "/projects/alpha/move",
		headers: auth(),
		payload: { from: "dangling", to: "moved" },
	});
	expect(moved.statusCode).toBe(204);
	// The link moved as a link: it still points where it did, still dangling.
	expect(await readlink(join(project, "moved"))).toBe(join(homeDir, "gone.txt"));

	expect((await deleteFile("moved")).statusCode).toBe(204);
	expect(await readdir(project)).toEqual([]);
});

test("a write through a symlink says the name is a symbolic link", async () => {
	await symlink(join(homeDir, "outside.txt"), join(project, "escape.txt"));
	const response = await writeFile("escape.txt", "x", { "if-none-match": "*" });
	expect(response.statusCode).toBe(400);
	expect(response.json().error.message).toBe("that name is a symbolic link");
});

// --- SPEC.md §11.2: odd files and impossible moves ------------------------

test.skipIf(!haveMkfifo)("reading a FIFO is refused rather than hanging", async () => {
	await run("mkfifo", [join(project, "pipe")]);
	const response = await readFile("pipe");
	expect(response.statusCode).toBe(400);
	expect(response.json().error.message).toBe("not a regular file");
});

test("a directory cannot be moved into itself", async () => {
	await mkdir(join(project, "src"));
	const response = await app.inject({
		method: "POST",
		url: "/projects/alpha/move",
		headers: auth(),
		payload: { from: "src", to: "src/inner" },
	});
	expect(response.statusCode).toBe(400);
	expect(response.json().error.code).toBe("BAD_REQUEST");
});

test("a download carries a matching length and no etag", async () => {
	await writeFileFs(join(project, "notes.txt"), "hello");
	const response = await readFile("notes.txt", "&download=1");
	expect(response.statusCode).toBe(200);
	expect(response.headers.etag).toBeUndefined();
	expect(response.headers["content-length"]).toBe("5");
	expect(response.body).toBe("hello");
});

// --- SPEC.md §13.5: a streaming client is answered, not reset -------------

async function withListeningAgent<T>(body: (base: string) => Promise<T>): Promise<T> {
	const server = buildServer({ tokenPath: join(homeDir, "agent.token"), homeDir });
	await server.listen({ host: "127.0.0.1", port: 0 });
	const address = server.server.address();
	const port = typeof address === "object" && address ? address.port : 0;
	try {
		return await body(`http://127.0.0.1:${port}`);
	} finally {
		await server.close();
	}
}

/** A body with no Content-Length that keeps producing 1 MiB chunks. */
function chunkedBody(chunks: number, onChunk?: (index: number) => void) {
	let sent = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (sent >= chunks) {
				controller.close();
				return;
			}
			onChunk?.(sent);
			sent += 1;
			controller.enqueue(new Uint8Array(1024 * 1024).fill(0x61));
		},
	});
}

test("a streaming write past the cap gets a 413, not a reset", async () => {
	await withListeningAgent(async (base) => {
		const response = await fetch(`${base}/projects/alpha/file?path=big.txt`, {
			method: "PUT",
			headers: {
				...auth(),
				"content-type": "text/plain",
				"if-none-match": "*",
			},
			body: chunkedBody(8),
			duplex: "half",
		} as RequestInit & { duplex: "half" });
		expect(response.status).toBe(413);
		const failure = (await response.json()) as { error: { code: string } };
		expect(failure.error.code).toBe("FILE_TOO_LARGE");
	});
	expect(await readdir(project)).not.toContain("big.txt");
	expect(await tempLeftovers(project)).toEqual([]);
});

test("a streaming write under the cap still succeeds", async () => {
	await withListeningAgent(async (base) => {
		const response = await fetch(`${base}/projects/alpha/file?path=ok.txt`, {
			method: "PUT",
			headers: { ...auth(), "content-type": "text/plain", "if-none-match": "*" },
			body: chunkedBody(1),
			duplex: "half",
		} as RequestInit & { duplex: "half" });
		expect(response.status).toBe(200);
		const written = (await response.json()) as { size: number };
		expect(written.size).toBe(1024 * 1024);
	});
	expect((await stat(join(project, "ok.txt"))).size).toBe(1024 * 1024);
	expect(await tempLeftovers(project)).toEqual([]);
});

test("a client that aborts mid-stream leaves nothing behind", async () => {
	await withListeningAgent(async (base) => {
		const controller = new AbortController();
		const request = fetch(`${base}/projects/alpha/file?path=aborted.txt`, {
			method: "PUT",
			headers: { ...auth(), "content-type": "text/plain", "if-none-match": "*" },
			body: chunkedBody(2, (index) => {
				if (index === 1) controller.abort();
			}),
			signal: controller.signal,
			duplex: "half",
		} as RequestInit & { duplex: "half" });
		await expect(request).rejects.toThrow();
		// Let the server finish tearing the half-written upload down.
		await new Promise((resolve) => setTimeout(resolve, 100));
	});
	expect(await readdir(project)).not.toContain("aborted.txt");
	expect(await tempLeftovers(project)).toEqual([]);
});
