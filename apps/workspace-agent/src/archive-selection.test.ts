import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { MAX_DOWNLOAD_BYTES, MAX_DOWNLOAD_PATHS } from "@portikus/contracts";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { commonParent, outermostPaths } from "./projects.js";
import { buildServer } from "./server.js";

const run = promisify(execFile);
const TOKEN = "b".repeat(64);

let app: FastifyInstance;
let homeDir: string;
let alpha: string;

async function available(command: string, args: string[]): Promise<boolean> {
	try {
		await run(command, args);
		return true;
	} catch {
		return false;
	}
}

const haveZip = (await available("zip", ["-v"])) && (await available("unzip", ["-v"]));

beforeAll(async () => {
	homeDir = await mkdtemp(join(tmpdir(), "portikus-selection-"));
	const tokenPath = join(homeDir, "agent.token");
	await writeFile(tokenPath, `${TOKEN}\n`, { mode: 0o600 });
	app = buildServer({ tmuxSocketName: "portikus-test", tokenPath, homeDir });
	await app.ready();
});

afterAll(async () => {
	await app.close();
	await rm(homeDir, { recursive: true, force: true });
});

beforeEach(async () => {
	alpha = join(homeDir, "projects", "alpha");
	await rm(join(homeDir, "projects"), { recursive: true, force: true });
	await mkdir(join(alpha, "src", "lib"), { recursive: true });
	await writeFile(join(alpha, "src", "a.ts"), "a\n");
	await writeFile(join(alpha, "src", "lib", "b.ts"), "b\n");
	await writeFile(join(alpha, "README.md"), "# alpha\n");
});

function archive(paths: readonly string[], check = false) {
	const search = new URLSearchParams();
	for (const path of paths) search.append("path", path);
	if (check) search.set("check", "1");
	return app.inject({
		method: "GET",
		url: `/projects/alpha/archive?${search.toString()}`,
		headers: { authorization: `Bearer ${TOKEN}` },
	});
}

async function listing(payload: Buffer): Promise<string[]> {
	const zip = join(homeDir, "selection.zip");
	await writeFile(zip, payload);
	const { stdout } = await run("zipinfo", ["-1", zip]);
	await rm(zip, { force: true });
	return stdout.trim().split("\n").sort();
}

test("outermostPaths drops paths inside another selected path", () => {
	expect(outermostPaths(["/p/src/lib/b.ts", "/p/src", "/p/srcx", "/p/src"])).toEqual([
		"/p/src",
		"/p/srcx",
	]);
});

test("commonParent is the deepest directory holding every path", () => {
	expect(commonParent(["/p/src/a.ts", "/p/src/lib/b.ts"])).toBe("/p/src");
	expect(commonParent(["/p/src/a.ts", "/p/README.md"])).toBe("/p");
	expect(commonParent(["/p/srcx/a", "/p/src/b"])).toBe("/p");
});

test.skipIf(!haveZip)(
	"a selection zips from the common parent, nested paths once",
	async () => {
		const response = await archive(["src/a.ts", "src/lib", "src/lib/b.ts"]);
		expect(response.statusCode).toBe(200);
		expect(await listing(response.rawPayload)).toEqual(["a.ts", "lib/", "lib/b.ts"]);
	},
);

test.skipIf(!haveZip)(
	"a selected symlink is stored as a link, not followed",
	async () => {
		await symlink("/etc/passwd", join(alpha, "outside"));
		const response = await archive(["outside", "README.md"]);
		expect(response.statusCode).toBe(200);
		const zip = join(homeDir, "link.zip");
		await writeFile(zip, response.rawPayload);
		const { stdout } = await run("zipinfo", [zip, "outside"]);
		await rm(zip, { force: true });
		expect(stdout.startsWith("l")).toBe(true);
	},
);

test("a selection path that leaves the project is refused", async () => {
	const response = await archive(["README.md", "../beta"]);
	expect(response.statusCode).toBe(400);
	expect(response.json().error.code).toBe("PATH_INVALID");
});

test("a selection through a symlinked directory out of the project is refused", async () => {
	await symlink("/etc", join(alpha, "etc"));
	const response = await archive(["README.md", "etc/passwd"]);
	expect(response.statusCode).toBe(400);
	expect(response.json().error.code).toBe("PATH_INVALID");
});

test("a selection of more than the most paths is refused", async () => {
	const paths = Array.from({ length: MAX_DOWNLOAD_PATHS + 1 }, (_, n) => `f${n}`);
	const response = await archive(paths, true);
	expect(response.statusCode).toBe(400);
});

test("a selection's sizes add up against the download cap", async () => {
	await truncate(join(alpha, "src", "a.ts"), MAX_DOWNLOAD_BYTES / 2 + 1);
	await truncate(join(alpha, "README.md"), MAX_DOWNLOAD_BYTES / 2);
	const over = await archive(["src/a.ts", "README.md"], true);
	expect(over.statusCode).toBe(413);
	expect(over.json().error.code).toBe("FILE_TOO_LARGE");
	// The same file named twice, or inside a selected folder, counts once.
	const nested = await archive(["src", "src/a.ts", "src/lib"], true);
	expect(nested.statusCode).toBe(204);
});
