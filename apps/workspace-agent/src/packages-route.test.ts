/**
 * The reinstall note (SPEC.md §22.3, ADR 0042), through the agent's server so
 * its token check applies, against a fake home, image version and dpkg
 * status file.
 */
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { installedPackages, LIST_MAX_BYTES, parseAptList } from "./packages-route.js";
import { buildServer } from "./server.js";

const TOKEN = "p".repeat(64);
const auth = { authorization: `Bearer ${TOKEN}` };

let dir: string;
let home: string;
let app: FastifyInstance;

function stanza(name: string, status = "install ok installed"): string {
	return `Package: ${name}\nStatus: ${status}\nArchitecture: amd64\n`;
}

async function setImage(version: string): Promise<void> {
	await writeFile(join(dir, "image-version"), `${version}\n`);
}

async function setInstalled(...stanzas: string[]): Promise<void> {
	await writeFile(join(dir, "status"), stanzas.join("\n"));
}

async function setList(text: string): Promise<void> {
	await writeFile(join(home, ".portikus", "apt-packages.txt"), text);
}

async function note() {
	const response = await app.inject({
		method: "GET",
		url: "/packages/reinstall-note",
		headers: auth,
	});
	expect(response.statusCode).toBe(200);
	return response.json() as { packages: string[] };
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "portikus-packages-"));
	home = join(dir, "home");
	await mkdir(join(home, ".portikus"), { recursive: true });
	const tokenPath = join(dir, "agent.token");
	await writeFile(tokenPath, TOKEN);
	await setImage("2026.09.10");
	await setInstalled(stanza("git"), stanza("htop", "deinstall ok config-files"));
	app = buildServer({
		tmuxSocketName: "portikus-test",
		tokenPath,
		homeDir: home,
		packages: {
			imageVersionPath: join(dir, "image-version"),
			dpkgStatusPath: join(dir, "status"),
		},
	});
	await app.ready();
});

afterEach(async () => {
	await app.close();
});

describe("parsing", () => {
	test("reads the header and drops lines that are not package names", () => {
		expect(
			parseAptList("# portikus-image: 2026.09.9\nhtop\nlibc6:amd64\n$(id)\nhtop\n\n"),
		).toMatchObject({ image: "2026.09.9", packages: ["htop"] });
	});

	test("an unknown or missing header names no image", () => {
		expect(parseAptList("# portikus-image: unknown\nhtop\n").image).toBeNull();
		expect(parseAptList("htop\n")).toMatchObject({ image: null, packages: ["htop"] });
	});

	test("only fully installed packages count as installed", () => {
		expect([
			...installedPackages(
				[stanza("git"), stanza("htop", "deinstall ok config-files")].join("\n"),
			),
		]).toEqual(["git"]);
	});
});

describe("GET /packages/reinstall-note", () => {
	test("needs the agent token", async () => {
		const response = await app.inject({
			method: "GET",
			url: "/packages/reinstall-note",
		});
		expect(response.statusCode).toBe(401);
	});

	test("after a rebuild, lists the packages that are missing now", async () => {
		await setList("# portikus-image: 2026.09.9\ngit\nhtop\npython3-venv\n");
		expect(await note()).toEqual({ packages: ["htop", "python3-venv"] });
	});

	test("on the same image there is no note", async () => {
		await setList("# portikus-image: 2026.09.10\nhtop\n");
		expect(await note()).toEqual({ packages: [] });
	});

	test("with nothing missing there is no note", async () => {
		await setList("# portikus-image: 2026.09.9\ngit\n");
		expect(await note()).toEqual({ packages: [] });
	});

	test("without a list, or when either version is unknown, there is no note", async () => {
		expect(await note()).toEqual({ packages: [] });
		await setList("# portikus-image: unknown\nhtop\n");
		expect(await note()).toEqual({ packages: [] });
		await setList("# portikus-image: 2026.09.9\nhtop\n");
		await setImage("unknown");
		expect(await note()).toEqual({ packages: [] });
	});

	test("a list that is a link is not read", async () => {
		await writeFile(join(dir, "elsewhere"), "# portikus-image: 2026.09.9\nhtop\n");
		await symlink(join(dir, "elsewhere"), join(home, ".portikus", "apt-packages.txt"));
		expect(await note()).toEqual({ packages: [] });
	});

	test("an oversized list is not read", async () => {
		await setList(`# portikus-image: 2026.09.9\nhtop\n${"a".repeat(LIST_MAX_BYTES)}\n`);
		expect(await note()).toEqual({ packages: [] });
	});
});

describe("POST /packages/reinstall-note/dismiss", () => {
	test("rewrites the header to the running image and keeps the list", async () => {
		await setList("# portikus-image: 2026.09.9\nhtop\npython3-venv\n");
		const response = await app.inject({
			method: "POST",
			url: "/packages/reinstall-note/dismiss",
			headers: auth,
		});
		expect(response.statusCode).toBe(204);
		expect(await readFile(join(home, ".portikus", "apt-packages.txt"), "utf8")).toBe(
			"# portikus-image: 2026.09.10\nhtop\npython3-venv\n",
		);
		expect(await note()).toEqual({ packages: [] });
	});

	test("never writes through a planted link", async () => {
		const target = join(dir, "not-mine");
		await writeFile(target, "keep\n");
		await symlink(target, join(home, ".portikus", "apt-packages.txt"));
		const response = await app.inject({
			method: "POST",
			url: "/packages/reinstall-note/dismiss",
			headers: auth,
		});
		expect(response.statusCode).toBe(204);
		expect(await readFile(target, "utf8")).toBe("keep\n");
	});

	test("with no list it does nothing", async () => {
		const response = await app.inject({
			method: "POST",
			url: "/packages/reinstall-note/dismiss",
			headers: auth,
		});
		expect(response.statusCode).toBe(204);
	});
});
