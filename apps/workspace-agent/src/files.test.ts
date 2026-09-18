import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile as readFileFs,
	rm,
	symlink,
	writeFile as writeFileFs,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { MAX_EDITOR_FILE_BYTES, MAX_TREE_ENTRIES } from "@portikus/contracts";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
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
	expect((await deleteFile("escape.txt")).json().error.code).toBe("PATH_INVALID");
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
		'attachment; filename="big.txt"',
	);
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
