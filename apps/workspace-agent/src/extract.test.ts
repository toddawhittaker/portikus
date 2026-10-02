/**
 * "Extract here" against real unzip in a temporary home
 * (SPEC.md §11.1, §24.6). Hostile zips are written by hand, because no zip
 * tool will store `../` or an absolute name on purpose. The invariant for
 * every hostile case: nothing outside the new folder is written, the new
 * folder is gone, and the zip is refused as a whole.
 */
import { execFile } from "node:child_process";
import {
	lstat,
	mkdir,
	mkdtemp,
	open,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { crc32, deflateRawSync } from "node:zlib";
import { MAX_EXTRACT_BYTES, MAX_EXTRACT_ENTRIES } from "@portikus/contracts";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	checkEntries,
	checkExtracted,
	extractZip,
	folderNameFor,
	readZipEntries,
	safeEntryName,
} from "./extract.js";
import { buildServer } from "./server.js";

// A small cap, so a zip that unpacks past it (plus the agent's margin)
// stays quick to build and to write.
vi.mock("@portikus/contracts", async (original) => ({
	...(await original<typeof import("@portikus/contracts")>()),
	MAX_EXTRACT_BYTES: 4 * 1024 * 1024,
}));

const run = promisify(execFile);
const TOKEN = "e".repeat(64);

interface Member {
	name: string;
	data?: string;
	/** A Unix mode, file type included; set means "made on Unix". */
	mode?: number;
	/** A size to claim in the central directory instead of the real one. */
	declaredSize?: number;
	flags?: number;
	/** The made-by host; defaults to Unix (3) when a mode is set, else DOS. */
	host?: number;
	/** Raw extra-field bytes for the central directory entry. */
	extra?: Buffer;
	/** Real bytes of zeros to deflate instead of `data`. */
	zeros?: number;
}

/** A stored (uncompressed) zip holding exactly the given members. */
function makeZip(members: Member[], storedCount = members.length): Buffer {
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;
	for (const member of members) {
		const name = Buffer.from(member.name, "utf8");
		const plain =
			member.zeros === undefined
				? Buffer.from(member.data ?? "", "utf8")
				: Buffer.alloc(member.zeros);
		const method = member.zeros === undefined ? 0 : 8;
		const data = method === 8 ? deflateRawSync(plain) : plain;
		const sum = crc32(plain);
		const size = member.declaredSize ?? plain.length;
		const extra = member.extra ?? Buffer.alloc(0);
		const host = member.host ?? (member.mode === undefined ? 0 : 3);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(member.flags ?? 0, 6);
		local.writeUInt16LE(method, 8);
		local.writeUInt32LE(sum, 14);
		local.writeUInt32LE(data.length, 18);
		local.writeUInt32LE(size, 22);
		local.writeUInt16LE(name.length, 26);
		local.writeUInt16LE(extra.length, 28);
		locals.push(local, name, extra, data);

		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE((host << 8) | 20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(member.flags ?? 0, 8);
		central.writeUInt16LE(method, 10);
		central.writeUInt32LE(sum, 16);
		central.writeUInt32LE(data.length, 20);
		central.writeUInt32LE(size, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt16LE(extra.length, 30);
		central.writeUInt32LE(((member.mode ?? 0) << 16) >>> 0, 38);
		central.writeUInt32LE(offset, 42);
		centrals.push(central, name, extra);
		offset += local.length + name.length + extra.length + data.length;
	}
	const centralBytes = Buffer.concat(centrals);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(storedCount, 8);
	end.writeUInt16LE(storedCount, 10);
	end.writeUInt32LE(centralBytes.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, centralBytes, end]);
}

const FILE = 0o100644;
const ABSOLUTE = "/tmp/portikus-zip-slip-absolute.txt";
const LINK = 0o120777;

let homeDir: string;
let project: string;
let outside: string;

beforeEach(async () => {
	homeDir = await mkdtemp(join(tmpdir(), "portikus-extract-"));
	project = join(homeDir, "projects", "alpha");
	outside = join(homeDir, "outside");
	await mkdir(join(project, "sub"), { recursive: true });
	await mkdir(outside);
	await writeFile(join(outside, "secret.txt"), "secret");
});

afterEach(async () => {
	await rm(homeDir, { recursive: true, force: true });
});

async function place(
	name: string,
	members: Member[],
	storedCount?: number,
): Promise<void> {
	await writeFile(join(project, name), makeZip(members, storedCount));
}

/** Nothing outside the project changed, and no folder was left behind. */
async function expectUntouched(folder: string): Promise<void> {
	expect(await readdir(outside)).toEqual(["secret.txt"]);
	expect((await readdir(homeDir)).sort()).toEqual(["outside", "projects"]);
	await expect(lstat(join(project, folder))).rejects.toThrow();
}

describe("extracting a zip", () => {
	test("puts its files in a new folder named after the zip, beside it", async () => {
		await place("sub/starter.zip", [
			{ name: "README.md", data: "# hi\n" },
			{ name: "src/", mode: 0o40755 },
			{ name: "src/app.js", data: "console.log(1);\n", mode: FILE },
		]);
		expect(await extractZip(homeDir, "alpha", "sub/starter.zip")).toBe("sub/starter");
		expect(await readFile(join(project, "sub/starter/README.md"), "utf8")).toBe(
			"# hi\n",
		);
		expect(await readFile(join(project, "sub/starter/src/app.js"), "utf8")).toBe(
			"console.log(1);\n",
		);
	});

	test("adds a number rather than merging into a folder that exists", async () => {
		await place("starter.zip", [{ name: "new.txt", data: "new" }]);
		await mkdir(join(project, "starter"));
		await writeFile(join(project, "starter", "mine.txt"), "mine");
		expect(await extractZip(homeDir, "alpha", "starter.zip")).toBe("starter-2");
		expect(await extractZip(homeDir, "alpha", "starter.zip")).toBe("starter-3");
		expect(await readdir(join(project, "starter"))).toEqual(["mine.txt"]);
		expect(await readFile(join(project, "starter-2", "new.txt"), "utf8")).toBe("new");
	});

	test("refuses even a link that stays inside the folder", async () => {
		await place("ok.zip", [
			{ name: "a.txt", data: "a", mode: FILE },
			{ name: "b", data: "a.txt", mode: LINK },
		]);
		await expect(extractZip(homeDir, "alpha", "ok.zip")).rejects.toMatchObject({
			code: "ARCHIVE_INVALID",
		});
		await expectUntouched("ok");
	});

	test("refuses something that is not a zip, and leaves no folder", async () => {
		await writeFile(join(project, "fake.zip"), "not a zip at all");
		await expect(extractZip(homeDir, "alpha", "fake.zip")).rejects.toMatchObject({
			code: "ARCHIVE_INVALID",
		});
		await expectUntouched("fake");
	});

	test("refuses a file without the .zip extension", async () => {
		await writeFile(join(project, "notes.txt"), makeZip([{ name: "a", data: "a" }]));
		await expect(extractZip(homeDir, "alpha", "notes.txt")).rejects.toMatchObject({
			code: "ARCHIVE_INVALID",
		});
	});

	test("refuses a zip whose end record hides central entries", async () => {
		// unzip reads every central entry while the signature matches, so a
		// low stored count must not hide the rest from the checks.
		await place(
			"hidden.zip",
			[
				{ name: "a.txt", data: "a" },
				{ name: ".git/config", data: "[core]\n\tfsmonitor = evil\n" },
			],
			1,
		);
		await expect(extractZip(homeDir, "alpha", "hidden.zip")).rejects.toMatchObject({
			code: "ARCHIVE_INVALID",
		});
		await expectUntouched("hidden");
	});

	test("never names the new folder .git", async () => {
		await place("sub/.git.zip", [{ name: "config", data: "x" }]);
		expect(await extractZip(homeDir, "alpha", "sub/.git.zip")).toBe("sub/git-archive");
		await expect(lstat(join(project, "sub/.git"))).rejects.toThrow();
	});

	test("refuses a password-protected zip", async () => {
		await place("locked.zip", [{ name: "a.txt", data: "a", flags: 1 }]);
		await expect(extractZip(homeDir, "alpha", "locked.zip")).rejects.toMatchObject({
			code: "ARCHIVE_INVALID",
		});
		await expectUntouched("locked");
	});
});

describe("zip-slip: hostile entries never write outside the new folder", () => {
	const hostile: [string, () => Member[]][] = [
		["a ../../ traversal", () => [{ name: "../../outside/passwd", data: "x" }]],
		[
			"the classic ../../etc/passwd",
			() => [{ name: "../../../../../../etc/passwd", data: "x" }],
		],
		[
			"a traversal after a real folder",
			() => [{ name: "src/../../../outside/x", data: "x" }],
		],
		["a backslash traversal", () => [{ name: "..\\..\\outside\\x", data: "x" }]],
		["an absolute path", () => [{ name: ABSOLUTE, data: "x" }]],
		["a drive-letter path", () => [{ name: "C:/outside/x", data: "x" }]],
		[
			"a chain of links that each look inside but end outside",
			() => [
				{ name: "s", data: ".", mode: LINK },
				{ name: "t", data: "s/..", mode: LINK },
				{ name: "u", data: "t/..", mode: LINK },
				{ name: "v", data: "u/..", mode: LINK },
			],
		],
		...[2, 5, 16, 30].map((host): [string, () => Member[]] => [
			`a link from made-by host ${host}`,
			() => [{ name: "in", data: "fine.txt", mode: LINK, host }],
		]),
		[
			"a Unicode path extra field naming something else",
			() => {
				const other = Buffer.from("other.txt", "utf8");
				const extra = Buffer.alloc(9 + other.length);
				extra.writeUInt16LE(0x7075, 0);
				extra.writeUInt16LE(5 + other.length, 2);
				extra.writeUInt8(1, 4);
				extra.writeUInt32LE(crc32(Buffer.from("plain.txt")), 5);
				other.copy(extra, 9);
				return [{ name: "plain.txt", data: "x", extra }];
			},
		],
		["a .git/config entry", () => [{ name: ".git/config", data: "[core]\n" }]],
		["a .GIT entry in any case", () => [{ name: "src/.GIT/x", data: "x" }]],
		[
			"a file written through its own link",
			() => [
				{ name: "hop", data: outside, mode: LINK },
				{ name: "hop/planted.txt", data: "planted", mode: FILE },
			],
		],
	];
	for (const [label, members] of hostile) {
		test(`refuses ${label} before extracting anything`, async () => {
			await place("evil.zip", [{ name: "fine.txt", data: "fine" }, ...members()]);
			await expect(extractZip(homeDir, "alpha", "evil.zip")).rejects.toMatchObject({
				code: "ARCHIVE_INVALID",
			});
			await expectUntouched("evil");
			await expect(lstat(ABSOLUTE)).rejects.toThrow();
		});
	}

	for (const [label, target] of [
		["an absolute link", "/etc"],
		["a relative link that climbs out", "../../outside"],
	] as const) {
		test(`refuses ${label} and removes the folder`, async () => {
			await place("links.zip", [
				{ name: "fine.txt", data: "fine", mode: FILE },
				{ name: "out", data: target, mode: LINK },
			]);
			await expect(extractZip(homeDir, "alpha", "links.zip")).rejects.toMatchObject({
				code: "ARCHIVE_INVALID",
			});
			await expectUntouched("links");
		});
	}

	test("refuses a zip that is itself a symbolic link", async () => {
		await writeFile(join(outside, "real.zip"), makeZip([{ name: "a", data: "a" }]));
		await run("ln", ["-s", join(outside, "real.zip"), join(project, "link.zip")]);
		await expect(extractZip(homeDir, "alpha", "link.zip")).rejects.toMatchObject({
			code: "PATH_INVALID",
		});
	});
});

describe("zip bombs", () => {
	test("refuses a zip that says it unpacks past the cap, before writing", async () => {
		await place("bomb.zip", [
			{ name: "a.bin", data: "a", declaredSize: MAX_EXTRACT_BYTES },
			{ name: "b.bin", data: "b", declaredSize: 1 },
		]);
		await expect(extractZip(homeDir, "alpha", "bomb.zip")).rejects.toMatchObject({
			code: "FILE_TOO_LARGE",
		});
		await expectUntouched("bomb");
	});

	test("stops a zip whose headers lie about sizes once it passes the cap", async () => {
		// 48 MB of real bytes, each entry claiming one byte; the slack keeps
		// other tests freeing space from hiding the drop.
		const members = Array.from({ length: 48 }, (_, index) => ({
			name: `z${index}.bin`,
			zeros: 1_000_000,
			declaredSize: 1,
		}));
		await place("liar.zip", members);
		await expect(extractZip(homeDir, "alpha", "liar.zip")).rejects.toMatchObject({
			code: "FILE_TOO_LARGE",
		});
		await expectUntouched("liar");
	});

	test("refuses a zip with more entries than the cap", async () => {
		const members = Array.from({ length: MAX_EXTRACT_ENTRIES + 1 }, (_, index) => ({
			name: `f${index}`,
		}));
		await place("many.zip", members);
		await expect(extractZip(homeDir, "alpha", "many.zip")).rejects.toMatchObject({
			code: "FILE_TOO_LARGE",
		});
		await expectUntouched("many");
	});
});

describe("an aborted request", () => {
	test("stops unzip and leaves no folder", async () => {
		await place("slow.zip", [{ name: "a.bin", zeros: 1_000_000 }]);
		const aborted = new AbortController();
		const pending = extractZip(homeDir, "alpha", "slow.zip", aborted.signal);
		aborted.abort();
		await expect(pending).rejects.toMatchObject({ code: "INTERNAL" });
		await expectUntouched("slow");
	});
});

describe("the walk after extraction", () => {
	test("refuses a .git folder in any case", async () => {
		await mkdir(join(project, "out", "a", ".Git"), { recursive: true });
		await expect(checkExtracted(join(project, "out"))).rejects.toMatchObject({
			code: "ARCHIVE_INVALID",
		});
	});
});

describe("the pure checks", () => {
	test("safeEntryName", () => {
		expect(safeEntryName("src/app.js")).toBe(true);
		expect(safeEntryName("a..b/c")).toBe(true);
		for (const name of ["", "/etc/passwd", "../x", "a/../../x", "C:/x", "a\0b"]) {
			expect(safeEntryName(name)).toBe(false);
		}
	});

	test("folderNameFor", () => {
		expect(folderNameFor("starter.zip")).toBe("starter");
		expect(folderNameFor("Starter.ZIP")).toBe("Starter");
		expect(folderNameFor(".zip")).toBe("archive");
		expect(folderNameFor(".git.zip")).toBe("git-archive");
		expect(folderNameFor(".GIT.Zip")).toBe("git-archive");
	});

	test("readZipEntries refuses central entries past the stored count", async () => {
		await place(
			"hidden.zip",
			[
				{ name: "a.txt", data: "a" },
				{ name: ".git/config", data: "x" },
			],
			1,
		);
		const handle = await open(join(project, "hidden.zip"));
		await expect(readZipEntries(handle)).rejects.toMatchObject({
			code: "ARCHIVE_INVALID",
		});
		await handle.close();
	});

	test("checkEntries passes a plain zip and readZipEntries reads names", async () => {
		await place("plain.zip", [{ name: "a\\b.txt", data: "x" }]);
		const handle = await open(join(project, "plain.zip"));
		const entries = await readZipEntries(handle);
		await handle.close();
		expect(entries.map((entry) => entry.name)).toEqual(["a/b.txt"]);
		expect(() => checkEntries(entries)).not.toThrow();
	});
});

describe("POST /projects/:slug/extract", () => {
	let app: FastifyInstance;
	beforeEach(async () => {
		const tokenPath = join(homeDir, "agent.token");
		await writeFile(tokenPath, `${TOKEN}\n`, { mode: 0o600 });
		app = buildServer({ tmuxSocketName: "portikus-test", tokenPath, homeDir });
		await app.ready();
	});
	afterEach(async () => {
		await app.close();
		await rm(join(homeDir, "agent.token"));
	});

	function post(body: object) {
		return app.inject({
			method: "POST",
			url: "/projects/alpha/extract",
			headers: { authorization: `Bearer ${TOKEN}` },
			payload: body,
		});
	}

	test("answers 201 with the new folder", async () => {
		await place("starter.zip", [{ name: "a.txt", data: "a" }]);
		const response = await post({ path: "starter.zip" });
		expect(response.statusCode).toBe(201);
		expect(response.json()).toEqual({ path: "starter" });
	});

	test("answers 422 ARCHIVE_INVALID for a zip-slip entry", async () => {
		await place("evil.zip", [{ name: "../../outside/x", data: "x" }]);
		const response = await post({ path: "evil.zip" });
		expect(response.statusCode).toBe(422);
		expect(response.json().error.code).toBe("ARCHIVE_INVALID");
		await expect(lstat(join(project, "evil"))).rejects.toThrow();
		expect(await readdir(outside)).toEqual(["secret.txt"]);
	});

	test("answers 400 for a path that leaves the project", async () => {
		const response = await post({ path: "../outside/secret.txt" });
		expect(response.statusCode).toBe(400);
	});
});
