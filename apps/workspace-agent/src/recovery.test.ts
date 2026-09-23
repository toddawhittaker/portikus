/**
 * Recovery points against real Git and real GNU tar in a temporary home
 * (SPEC.md §12.5, §15.2–15.5, §15.8, §24.6; ADR 0020).
 */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	readlink,
	rm,
	stat,
	symlink,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	createRecoveryPoint,
	deleteProjectRecoveryPoints,
	deleteRecoveryPoint,
	RecoveryLocks,
	type RecoveryPaths,
	removeRestoreLeftovers,
	restoreRecoveryPoint,
	safeMemberName,
	walkProject,
} from "./recovery.js";
import { recoveryMatcher } from "./workspace-ignore.js";

const run = promisify(execFile);

let base: string;
let paths: RecoveryPaths;
let project: string;
let outside: string;
const projectId = randomUUID();

async function git(args: string[]): Promise<string> {
	const { stdout } = await run("git", args, { cwd: project });
	return stdout;
}

/** Everything a point must leave alone, read without changing it. */
async function gitState() {
	return {
		head: await git(["rev-parse", "HEAD"]),
		refs: await git(["for-each-ref"]),
		stash: await git(["stash", "list"]),
		reflog: await git(["reflog", "--all"]),
		index: createHash("sha256")
			.update(await readFile(join(project, ".git", "index")))
			.digest("hex"),
	};
}

/** Member lines of an archive, verbose so links show their targets. */
async function listMembers(file: string): Promise<string[]> {
	const tarBytes = zstdDecompressSync(await readFile(file));
	const listing = await new Promise<string>((resolve, reject) => {
		const child = execFile("tar", ["-tvf", "-"], (error, stdout) =>
			error ? reject(error) : resolve(stdout),
		);
		child.stdin?.end(tarBytes);
	});
	return listing.split("\n").filter((line) => line !== "");
}

function names(lines: string[]): string[] {
	// "mode owner size date time name[ -> target]"
	return lines.map((line) =>
		line
			.split(/\s+/)
			.slice(5)
			.join(" ")
			.replace(/ -> .*$/, ""),
	);
}

async function point(options: { skipIfFingerprint?: string; pointId?: string } = {}) {
	const pointId = options.pointId ?? randomUUID();
	const result = await createRecoveryPoint(paths, {
		slug: "alpha",
		projectId,
		pointId,
		skipIfFingerprint: options.skipIfFingerprint,
	});
	return {
		pointId,
		result,
		file: join(paths.recoveryRoot, projectId, `${pointId}.tar.zst`),
	};
}

async function sha(file: string): Promise<string> {
	return createHash("sha256")
		.update(await readFile(file))
		.digest("hex");
}

beforeEach(async () => {
	base = await mkdtemp(join(tmpdir(), "portikus-recovery-"));
	const homeDir = join(base, "home");
	const recoveryRoot = join(base, "recovery");
	outside = join(base, "outside");
	await mkdir(join(homeDir, "projects", "alpha"), { recursive: true });
	await mkdir(recoveryRoot, { mode: 0o700 });
	await mkdir(outside);
	await writeFile(join(outside, "target.txt"), "OUTSIDE-SECRET\n");
	paths = { homeDir, recoveryRoot };
	project = join(homeDir, "projects", "alpha");

	await git(["init", "-q", "-b", "main"]);
	await git(["config", "user.email", "s@example.edu"]);
	await git(["config", "user.name", "Student"]);
	await writeFile(join(project, ".gitignore"), ".env\nnode_modules/\ndist/\n");
	await mkdir(join(project, "src"));
	await writeFile(join(project, "src", "app.js"), "console.log(1);\n");
	await git(["add", "."]);
	await git(["commit", "-q", "-m", "one"]);
	await writeFile(join(project, "src", "app.js"), "console.log(2);\n");
	await git(["commit", "-q", "-am", "two"]);
	await writeFile(join(project, "notes.txt"), "stashed\n");
	await git(["stash", "push", "-u", "-q", "-m", "student stash"]);

	await writeFile(join(project, ".env"), "TOKEN=abc\n");
	await mkdir(join(project, "node_modules", "left-pad"), { recursive: true });
	await writeFile(join(project, "node_modules", "left-pad", "index.js"), "module\n");
	await mkdir(join(project, "packages", "web", "node_modules"), { recursive: true });
	await writeFile(
		join(project, "packages", "web", "node_modules", "dep.js"),
		"nested\n",
	);
	await writeFile(join(project, "packages", "web", "main.js"), "web\n");
	await mkdir(join(project, "dist"));
	await writeFile(join(project, "dist", "bundle.js"), "bundle\n");
	await symlink(join(outside, "target.txt"), join(project, "link-out"));
	await symlink(outside, join(project, "dir-out"));
});

afterEach(async () => {
	await rm(base, { recursive: true, force: true });
});

describe("making a point", () => {
	test("leaves HEAD, refs, stash, reflog and the index bytes unchanged", async () => {
		const before = await gitState();
		const { result } = await point();
		expect(result.created).toBe(true);
		expect(await gitState()).toEqual(before);
	});

	test("is a 0600 tar.zst in a 0700 directory named by the project id", async () => {
		const { result, file } = await point();
		if (!result.created) throw new Error("expected a point");
		expect((await stat(file)).mode & 0o777).toBe(0o600);
		expect((await stat(join(paths.recoveryRoot, projectId))).mode & 0o777).toBe(0o700);
		expect(result.sizeBytes).toBe((await stat(file)).size);
		expect(result.sha256).toBe(await sha(file));
		// Node's zstd round-trips, pinned here as ADR 0020 asks.
		expect(zstdDecompressSync(await readFile(file)).length).toBeGreaterThan(0);
		expect(await readdir(join(paths.recoveryRoot, projectId))).toEqual([
			`${file.split("/").pop()}`,
		]);
	});

	test("includes .git and ignored files, and leaves out the defaults at any depth", async () => {
		const { file } = await point();
		const listed = names(await listMembers(file));
		expect(listed).toContain(".env");
		expect(listed).toContain(".git/HEAD");
		expect(listed).toContain("src/app.js");
		expect(listed).toContain("packages/web/main.js");
		expect(listed.some((name) => name.includes("node_modules"))).toBe(false);
		expect(listed.some((name) => name.startsWith("dist"))).toBe(false);
	});

	test(".workspaceignore adds exclusions and !dist/ brings dist back", async () => {
		await mkdir(join(project, "big-data"));
		await writeFile(join(project, "big-data", "x.csv"), "1,2\n");
		await writeFile(join(project, ".workspaceignore"), "big-data/\n!dist/\n");
		const { file } = await point();
		const listed = names(await listMembers(file));
		expect(listed).toContain("dist/bundle.js");
		expect(listed).toContain(".workspaceignore");
		expect(listed.some((name) => name.startsWith("big-data"))).toBe(false);
		expect(listed.some((name) => name.includes("node_modules"))).toBe(false);
	});

	test("stores symlinks as links and never reads their targets", async () => {
		const { file } = await point();
		const lines = await listMembers(file);
		const linkLine = lines.find((line) => line.includes("link-out"));
		expect(linkLine?.startsWith("l")).toBe(true);
		expect(linkLine).toContain(`-> ${join(outside, "target.txt")}`);
		const dirLine = lines.find((line) => line.includes("dir-out"));
		expect(dirLine?.startsWith("l")).toBe(true);
		expect(names(lines).some((name) => name.startsWith("dir-out/"))).toBe(false);
		const bytes = zstdDecompressSync(await readFile(file)).toString("latin1");
		expect(bytes).not.toContain("OUTSIDE-SECRET");
	});

	test("an unchanged project writes nothing when the fingerprint matches", async () => {
		const first = await point();
		if (!first.result.created) throw new Error("expected a point");
		const second = await point({ skipIfFingerprint: first.result.fingerprint });
		expect(second.result).toEqual({
			created: false,
			fingerprint: first.result.fingerprint,
		});
		expect(await readdir(join(paths.recoveryRoot, projectId))).toHaveLength(1);

		// A change the fingerprint sees makes a new point.
		const later = new Date(Date.now() + 5000);
		await writeFile(join(project, "src", "app.js"), "console.log(3);\n");
		await utimes(join(project, "src", "app.js"), later, later);
		const third = await point({ skipIfFingerprint: first.result.fingerprint });
		expect(third.result.created).toBe(true);
		expect(third.result.fingerprint).not.toBe(first.result.fingerprint);
	});

	test("an excluded path changing does not change the fingerprint", async () => {
		const before = await walkProject(project, recoveryMatcher(""));
		await writeFile(join(project, "node_modules", "left-pad", "index.js"), "changed\n");
		const after = await walkProject(project, recoveryMatcher(""));
		expect(after.fingerprint).toBe(before.fingerprint);
		expect(after.paths).toEqual(before.paths);
	});

	test("refuses a symlinked project directory on the recovery volume", async () => {
		await symlink(outside, join(paths.recoveryRoot, projectId));
		await expect(point()).rejects.toMatchObject({ code: "INTERNAL" });
		expect(await readdir(outside)).toEqual(["target.txt"]);
	});

	test("refuses when the recovery volume is not there", async () => {
		await rm(paths.recoveryRoot, { recursive: true });
		await expect(point()).rejects.toMatchObject({ code: "INTERNAL" });
	});

	test("refuses a project that does not exist", async () => {
		await expect(
			createRecoveryPoint(paths, { slug: "nope", projectId, pointId: randomUUID() }),
		).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
	});
});

describe("restoring a point", () => {
	test("puts back files and .git after rm -rf .git and git reset --hard, in the same directory", async () => {
		const before = await gitState();
		const status = await git(["status", "--porcelain"]);
		const inode = (await stat(project)).ino;
		const { pointId, file } = await point();

		await git(["reset", "-q", "--hard", "HEAD~1"]);
		await rm(join(project, ".git"), { recursive: true, force: true });
		await rm(join(project, ".env"));
		await writeFile(join(project, "packages", "web", "main.js"), "damaged\n");
		await writeFile(join(project, "new-file.txt"), "made after the point\n");
		await writeFile(
			join(project, "node_modules", "left-pad", "index.js"),
			"kept as is\n",
		);

		await restoreRecoveryPoint(paths, {
			slug: "alpha",
			projectId,
			pointId,
			sha256: await sha(file),
		});

		expect((await stat(project)).ino).toBe(inode);
		expect(await gitState()).toEqual(before);
		expect(await git(["status", "--porcelain"])).toBe(status);
		expect(await readFile(join(project, "src", "app.js"), "utf8")).toBe(
			"console.log(2);\n",
		);
		expect(await readFile(join(project, ".env"), "utf8")).toBe("TOKEN=abc\n");
		expect(await readFile(join(project, "packages", "web", "main.js"), "utf8")).toBe(
			"web\n",
		);
		await expect(stat(join(project, "new-file.txt"))).rejects.toThrow();
		// Excluded directories, nested ones included, are left exactly as they were.
		expect(
			await readFile(join(project, "node_modules", "left-pad", "index.js"), "utf8"),
		).toBe("kept as is\n");
		expect(
			await readFile(
				join(project, "packages", "web", "node_modules", "dep.js"),
				"utf8",
			),
		).toBe("nested\n");
		expect(await readFile(join(project, "dist", "bundle.js"), "utf8")).toBe("bundle\n");
		// No staging directory is left behind.
		expect(await readdir(join(paths.homeDir, "projects"))).toEqual(["alpha"]);
	});

	test("never follows a symlink when deleting or restoring", async () => {
		const { pointId, file } = await point();
		// Replace a restored directory with a link out, so a restore that
		// followed links would write into, or delete from, the outside.
		await rm(join(project, "src"), { recursive: true });
		await symlink(outside, join(project, "src"));
		await restoreRecoveryPoint(paths, {
			slug: "alpha",
			projectId,
			pointId,
			sha256: await sha(file),
		});

		expect((await lstat(join(project, "src"))).isDirectory()).toBe(true);
		expect(await readdir(outside)).toEqual(["target.txt"]);
		expect(await readFile(join(outside, "target.txt"), "utf8")).toBe(
			"OUTSIDE-SECRET\n",
		);
		expect(await readlink(join(project, "link-out"))).toBe(join(outside, "target.txt"));
		expect(await readlink(join(project, "dir-out"))).toBe(outside);
	});

	test("refuses an archive whose SHA-256 does not match the record", async () => {
		const { pointId } = await point();
		await writeFile(join(project, "src", "app.js"), "after\n");
		await expect(
			restoreRecoveryPoint(paths, {
				slug: "alpha",
				projectId,
				pointId,
				sha256: "0".repeat(64),
			}),
		).rejects.toMatchObject({ code: "RECOVERY_POINT_INVALID" });
		expect(await readFile(join(project, "src", "app.js"), "utf8")).toBe("after\n");
	});

	test("refuses a point of another project", async () => {
		const { pointId, file } = await point();
		await expect(
			restoreRecoveryPoint(paths, {
				slug: "alpha",
				projectId: randomUUID(),
				pointId,
				sha256: await sha(file),
			}),
		).rejects.toMatchObject({ code: "RECOVERY_POINT_INVALID" });
	});

	test("refuses an archive that is a symlink", async () => {
		const { pointId, file } = await point();
		const hash = await sha(file);
		await rm(file);
		const moved = join(base, "elsewhere.tar.zst");
		await writeFile(moved, "x");
		await symlink(moved, file);
		await expect(
			restoreRecoveryPoint(paths, { slug: "alpha", projectId, pointId, sha256: hash }),
		).rejects.toMatchObject({ code: "RECOVERY_POINT_INVALID" });
	});

	/** Write a crafted archive where a point would be, and return its hash. */
	async function crafted(
		pointId: string,
		tarArgs: string[],
		cwd: string,
	): Promise<string> {
		const { stdout } = await run("tar", ["-c", "-f", "-", ...tarArgs], {
			cwd,
			encoding: "buffer",
		});
		const bytes = zstdCompressSync(stdout);
		await mkdir(join(paths.recoveryRoot, projectId), { recursive: true, mode: 0o700 });
		await writeFile(join(paths.recoveryRoot, projectId, `${pointId}.tar.zst`), bytes);
		return createHash("sha256").update(bytes).digest("hex");
	}

	test("refuses a crafted ../ member before extracting anything", async () => {
		const pointId = randomUUID();
		await writeFile(join(base, "escape.txt"), "escaped\n");
		const hash = await crafted(pointId, ["-P", "../escape.txt"], join(base, "home"));
		await rm(join(base, "escape.txt"));
		await expect(
			restoreRecoveryPoint(paths, { slug: "alpha", projectId, pointId, sha256: hash }),
		).rejects.toMatchObject({
			code: "RECOVERY_POINT_INVALID",
			message: expect.stringContaining("unsafe"),
		});
		await expect(stat(join(base, "escape.txt"))).rejects.toThrow();
		await expect(stat(join(paths.homeDir, "escape.txt"))).rejects.toThrow();
		expect(await readFile(join(project, "src", "app.js"), "utf8")).toBe(
			"console.log(2);\n",
		);
	});

	test("refuses a crafted absolute member", async () => {
		const pointId = randomUUID();
		const absolute = join(base, "absolute.txt");
		await writeFile(absolute, "absolute\n");
		const hash = await crafted(pointId, ["-P", absolute], base);
		await rm(absolute);
		await expect(
			restoreRecoveryPoint(paths, { slug: "alpha", projectId, pointId, sha256: hash }),
		).rejects.toMatchObject({
			code: "RECOVERY_POINT_INVALID",
			message: expect.stringContaining("unsafe"),
		});
		await expect(stat(absolute)).rejects.toThrow();
	});

	test("refuses an archive that writes through its own symlink, and changes nothing", async () => {
		// Member "hop" is a link to the outside and member "hop/planted.txt"
		// would land there if tar followed it.
		const pointId = randomUUID();
		const work = join(base, "craft");
		await mkdir(join(work, "real"), { recursive: true });
		await symlink(outside, join(work, "hop"));
		await writeFile(join(work, "real", "planted.txt"), "planted\n");
		const hash = await crafted(
			pointId,
			["--transform", "s,^real,hop,", "hop", "real/planted.txt"],
			work,
		);
		await expect(
			restoreRecoveryPoint(paths, { slug: "alpha", projectId, pointId, sha256: hash }),
		).rejects.toMatchObject({ code: "RECOVERY_POINT_INVALID" });
		expect(await readdir(outside)).toEqual(["target.txt"]);
		expect(await readFile(join(project, "src", "app.js"), "utf8")).toBe(
			"console.log(2);\n",
		);
	});

	test("refuses a file that is not an archive", async () => {
		const pointId = randomUUID();
		await mkdir(join(paths.recoveryRoot, projectId), { recursive: true });
		await writeFile(
			join(paths.recoveryRoot, projectId, `${pointId}.tar.zst`),
			"not zstd",
		);
		const hash = createHash("sha256").update("not zstd").digest("hex");
		await expect(
			restoreRecoveryPoint(paths, { slug: "alpha", projectId, pointId, sha256: hash }),
		).rejects.toMatchObject({ code: "RECOVERY_POINT_INVALID" });
		expect(await readFile(join(project, "src", "app.js"), "utf8")).toBe(
			"console.log(2);\n",
		);
	});
});

describe("deleting points", () => {
	test("one point, then every point of the project", async () => {
		const first = await point();
		const second = await point();
		await deleteRecoveryPoint(paths.recoveryRoot, projectId, first.pointId);
		expect(await readdir(join(paths.recoveryRoot, projectId))).toEqual([
			`${second.pointId}.tar.zst`,
		]);
		// Already gone is fine.
		await deleteRecoveryPoint(paths.recoveryRoot, projectId, first.pointId);
		await deleteProjectRecoveryPoints(paths.recoveryRoot, projectId);
		await expect(stat(join(paths.recoveryRoot, projectId))).rejects.toThrow();
	});

	test("a symlinked project directory is removed as a link, its target kept", async () => {
		await symlink(outside, join(paths.recoveryRoot, projectId));
		await deleteRecoveryPoint(paths.recoveryRoot, projectId, randomUUID());
		await deleteProjectRecoveryPoints(paths.recoveryRoot, projectId);
		expect(await readdir(outside)).toEqual(["target.txt"]);
	});

	test("ids that are not uuids never become paths", async () => {
		await expect(
			deleteProjectRecoveryPoints(paths.recoveryRoot, ".."),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
		await expect(
			deleteRecoveryPoint(paths.recoveryRoot, projectId, "../../x"),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});
});

test("member names outside the extraction directory are unsafe", () => {
	expect(safeMemberName("src/app.js")).toBe(true);
	expect(safeMemberName("..hidden/x")).toBe(true);
	expect(safeMemberName("../x")).toBe(false);
	expect(safeMemberName("a/../../x")).toBe(false);
	expect(safeMemberName("/etc/passwd")).toBe(false);
});

test("a second operation on the same project is BUSY, another project is not", async () => {
	const locks = new RecoveryLocks();
	let release = () => {};
	const held = locks.run(
		"p1",
		() => new Promise<void>((resolve) => (release = resolve)),
	);
	await expect(locks.run("p1", async () => 1)).rejects.toMatchObject({ code: "BUSY" });
	await expect(locks.run("p2", async () => 2)).resolves.toBe(2);
	release();
	await held;
	await expect(locks.run("p1", async () => 3)).resolves.toBe(3);
});

describe("unreadable directories, changing files, and the point's own rules", () => {
	async function restore(pointId: string, file: string) {
		await restoreRecoveryPoint(paths, {
			slug: "alpha",
			projectId,
			pointId,
			sha256: await sha(file),
		});
	}

	test("an unreadable directory is left out of a point and kept by a restore", async () => {
		await mkdir(join(project, "pgdata"));
		await writeFile(join(project, "pgdata", "PG_VERSION"), "16\n");
		await chmod(join(project, "pgdata"), 0o000);
		try {
			const walk = await walkProject(project, recoveryMatcher(""));
			expect(walk.paths).not.toContain("pgdata");
			const { pointId, file } = await point();
			await writeFile(join(project, "src", "app.js"), "damaged\n");
			await restore(pointId, file);
			expect(await readFile(join(project, "src", "app.js"), "utf8")).toBe(
				"console.log(2);\n",
			);
			expect((await lstat(join(project, "pgdata"))).mode & 0o777).toBe(0);
		} finally {
			await chmod(join(project, "pgdata"), 0o700);
		}
		expect(await readFile(join(project, "pgdata", "PG_VERSION"), "utf8")).toBe("16\n");
	});

	test("an unreadable file is left out of a point and kept by a restore", async () => {
		await writeFile(join(project, "secret.key"), "only copy\n");
		await chmod(join(project, "secret.key"), 0o000);
		try {
			const { pointId, file } = await point();
			expect(names(await listMembers(file))).not.toContain("secret.key");
			await restore(pointId, file);
			expect((await lstat(join(project, "secret.key"))).mode & 0o777).toBe(0);
		} finally {
			await chmod(join(project, "secret.key"), 0o600);
		}
		expect(await readFile(join(project, "secret.key"), "utf8")).toBe("only copy\n");
	});

	test("a directory today's .workspaceignore excludes is kept by a restore", async () => {
		const { pointId, file } = await point();
		await writeFile(join(project, ".workspaceignore"), "datasets/\n");
		await mkdir(join(project, "datasets"));
		await writeFile(join(project, "datasets", "big.csv"), "only copy\n");
		await restore(pointId, file);
		expect(await readFile(join(project, "datasets", "big.csv"), "utf8")).toBe(
			"only copy\n",
		);
	});

	test("an aside copy already present refuses the restore and is kept", async () => {
		const { pointId, file } = await point();
		const aside = join(paths.homeDir, "projects", `.portikus-aside-${pointId}`);
		await mkdir(aside);
		await writeFile(join(aside, "rollback.txt"), "only copy\n");
		await expect(restore(pointId, file)).rejects.toMatchObject({
			code: "RESTORE_INCOMPLETE",
		});
		expect(await readFile(join(aside, "rollback.txt"), "utf8")).toBe("only copy\n");
	});

	test("the point's own .workspaceignore decides what a restore keeps", async () => {
		await writeFile(join(project, ".workspaceignore"), "scratch/\n");
		const { pointId, file } = await point();
		// The rule is dropped after the point; the directory must still be kept.
		await rm(join(project, ".workspaceignore"));
		await mkdir(join(project, "scratch"));
		await writeFile(join(project, "scratch", "data.csv"), "keep me\n");
		await restore(pointId, file);
		expect(await readFile(join(project, "scratch", "data.csv"), "utf8")).toBe(
			"keep me\n",
		);
		expect(await readFile(join(project, ".workspaceignore"), "utf8")).toBe(
			"scratch/\n",
		);
	});

	test("an archived build file never replaces a kept, excluded build/ directory", async () => {
		await writeFile(join(project, ".workspaceignore"), "build/\n");
		await writeFile(join(project, "build"), "a file then\n");
		const { pointId, file } = await point();
		await rm(join(project, "build"));
		await mkdir(join(project, "build"));
		await writeFile(join(project, "build", "out.js"), "built\n");
		await restore(pointId, file);
		expect(await readFile(join(project, "build", "out.js"), "utf8")).toBe("built\n");
		expect(await readdir(join(paths.homeDir, "projects"))).toEqual(["alpha"]);
	});

	test("leftover staging directories are removed; aside copies and others are kept", async () => {
		const root = join(paths.homeDir, "projects");
		const id = randomUUID();
		const linkName = `.portikus-restore-${randomUUID()}`;
		await mkdir(join(root, `.portikus-restore-${id}`));
		await mkdir(join(root, `.portikus-aside-${id}`));
		await symlink(outside, join(root, `.portikus-aside-${id}`, "out"));
		await symlink(outside, join(root, linkName));
		await mkdir(join(root, ".portikus-aside-not-a-uuid"));
		expect(await removeRestoreLeftovers(paths.homeDir)).toBe(1);
		expect((await readdir(root)).sort()).toEqual(
			[`.portikus-aside-${id}`, ".portikus-aside-not-a-uuid", "alpha", linkName].sort(),
		);
		expect(await readFile(join(outside, "target.txt"), "utf8")).toBe(
			"OUTSIDE-SECRET\n",
		);
	});
});
