/**
 * Recovery points: compressed copies of a project kept on the recovery
 * volume, and restoring one in place (SPEC.md §15, ADR 0020).
 *
 * Nothing here runs Git or writes inside `.git` except by restoring it as
 * files, so a point never commits, stashes, or moves a ref (SPEC.md §12.5).
 * Symlinks are stored, deleted, and restored as links and never followed
 * (SPEC.md §24.6). File names never reach a log line (ADR 0012).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
	chmod,
	lstat,
	mkdir,
	open,
	readdir,
	readlink,
	rename,
	rm,
	rmdir,
	unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createZstdCompress, createZstdDecompress } from "node:zlib";
import type { AgentCreateRecoveryPointResponse } from "@portikus/contracts";
import { projectsDir, resolveProject } from "./projects.js";
import { AgentFailure } from "./tmux.js";
import { loadRecoveryMatcher, type RecoveryMatcher } from "./workspace-ignore.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Where the recovery volume is and whose projects it holds. */
export interface RecoveryPaths {
	homeDir: string;
	recoveryRoot: string;
}

/**
 * One operation per project at a time. A second one is refused rather than
 * queued, so the API and the worker racing each other see `BUSY`.
 */
export class RecoveryLocks {
	private readonly held = new Set<string>();

	async run<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
		if (this.held.has(projectId)) {
			throw new AgentFailure(
				"BUSY",
				"another recovery operation is running on this project",
			);
		}
		this.held.add(projectId);
		try {
			return await operation();
		} finally {
			this.held.delete(projectId);
		}
	}
}

export interface ProjectWalk {
	/** Included paths, relative to the project, parents before children. */
	paths: string[];
	/** SHA-256 over every included entry's path, type, size, mtime, mode and link target. */
	fingerprint: string;
}

/**
 * List what a point of this project holds, using `lstat` only: a symlink is
 * an entry of its own and is never descended into. Sockets, FIFOs and
 * devices are left out.
 */
export async function walkProject(
	projectPath: string,
	matcher: RecoveryMatcher,
): Promise<ProjectWalk> {
	const paths: string[] = [];
	const lines: string[] = [];
	const visit = async (dirRel: string): Promise<void> => {
		let names: string[];
		try {
			names = await readdir(dirRel === "" ? projectPath : join(projectPath, dirRel));
		} catch (error) {
			// A directory removed while walking is simply not in this point.
			if (isMissing(error)) return;
			throw error;
		}
		names.sort();
		for (const name of names) {
			const rel = dirRel === "" ? name : `${dirRel}/${name}`;
			let info: Awaited<ReturnType<typeof lstat>>;
			try {
				info = await lstat(join(projectPath, rel));
			} catch (error) {
				if (isMissing(error)) continue;
				throw error;
			}
			let type: "dir" | "file" | "link";
			let target: string | null = null;
			if (info.isDirectory()) {
				if (matcher.excludes(`${rel}/`)) continue;
				type = "dir";
			} else if (info.isSymbolicLink()) {
				if (matcher.excludes(rel)) continue;
				type = "link";
				target = await readlink(join(projectPath, rel));
			} else if (info.isFile()) {
				if (matcher.excludes(rel)) continue;
				type = "file";
			} else {
				continue;
			}
			paths.push(rel);
			lines.push(
				JSON.stringify([
					rel,
					type,
					type === "dir" ? 0 : info.size,
					info.mtimeMs,
					info.mode,
					target,
				]),
			);
			if (type === "dir") await visit(rel);
		}
	};
	await visit("");
	lines.sort();
	const hash = createHash("sha256");
	for (const line of lines) hash.update(`${line}\n`);
	return { paths, fingerprint: hash.digest("hex") };
}

export interface CreatePointInput {
	slug: string;
	projectId: string;
	pointId: string;
	skipIfFingerprint?: string;
}

/**
 * Make a point, or nothing when the project's fingerprint equals
 * `skipIfFingerprint` (SPEC.md §15.6). The archive is written to a
 * `.partial` file and renamed once complete; a full volume becomes
 * `STORAGE_FULL` and leaves no file behind.
 */
export async function createRecoveryPoint(
	paths: RecoveryPaths,
	input: CreatePointInput,
): Promise<AgentCreateRecoveryPointResponse> {
	assertId(input.projectId);
	assertId(input.pointId);
	const project = await resolveProject(input.slug, paths.homeDir);
	if (!project.exists) {
		throw new AgentFailure("PROJECT_NOT_FOUND", "no such project");
	}
	const matcher = await loadRecoveryMatcher(project.path);
	const walk = await walkProject(project.path, matcher);
	if (input.skipIfFingerprint === walk.fingerprint) {
		return { created: false, fingerprint: walk.fingerprint };
	}
	const dir = await pointDirectory(paths.recoveryRoot, input.projectId, true);
	const final = join(dir, `${input.pointId}.tar.zst`);
	const partial = `${final}.partial`;
	try {
		const written = await writeArchive(project.path, walk.paths, partial);
		await rename(partial, final);
		return { created: true, ...written, fingerprint: walk.fingerprint };
	} catch (error) {
		await rm(partial, { force: true });
		if (isNoSpace(error)) {
			throw new AgentFailure("STORAGE_FULL", "recovery storage is full");
		}
		throw error;
	}
}

export interface RestorePointInput {
	slug: string;
	projectId: string;
	pointId: string;
	sha256: string;
}

/**
 * Put a point back into the existing project directory, whose inode is the
 * project's identity (SPEC.md §7.6, §15.8). The archive must match its
 * recorded SHA-256 and hold no absolute or `..` member before anything is
 * extracted (SPEC.md §24.6). Excluded paths such as `node_modules` stay as
 * they are.
 */
export async function restoreRecoveryPoint(
	paths: RecoveryPaths,
	input: RestorePointInput,
): Promise<void> {
	assertId(input.projectId);
	assertId(input.pointId);
	const project = await resolveProject(input.slug, paths.homeDir);
	if (!project.exists) {
		throw new AgentFailure("PROJECT_NOT_FOUND", "no such project");
	}
	const dir = await pointDirectory(paths.recoveryRoot, input.projectId, false);
	const archive = join(dir, `${input.pointId}.tar.zst`);

	const listed = await readArchive(archive, ["--list", "-P", "--quoting-style=escape"]);
	if (listed.sha256 !== input.sha256) {
		throw new AgentFailure(
			"RECOVERY_POINT_INVALID",
			"the recovery point does not match its record",
		);
	}
	for (const name of listed.stdout.split("\n")) {
		if (name !== "" && !safeMemberName(name)) {
			throw new AgentFailure(
				"RECOVERY_POINT_INVALID",
				"the recovery point holds an unsafe path",
			);
		}
	}

	// The name fails the slug pattern, so project discovery never lists it.
	const staging = join(
		projectsDir(paths.homeDir),
		`.portikus-restore-${input.pointId}`,
	);
	await rm(staging, { recursive: true, force: true });
	await mkdir(staging, { mode: 0o700 });
	try {
		const extracted = await readArchive(archive, [
			"--extract",
			"--directory",
			staging,
			"--no-same-owner",
			"--preserve-permissions",
		]);
		// Hashed again while extracting, so an archive swapped after the first
		// check never reaches the project.
		if (extracted.sha256 !== input.sha256) {
			throw new AgentFailure(
				"RECOVERY_POINT_INVALID",
				"the recovery point does not match its record",
			);
		}
		const matcher = await loadRecoveryMatcher(project.path);
		await clearIncluded(project.path, "", matcher);
		await moveInto(staging, project.path);
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
}

/** Remove one point's archive. A point already gone is not an error. */
export async function deleteRecoveryPoint(
	recoveryRoot: string,
	projectId: string,
	pointId: string,
): Promise<void> {
	assertId(projectId);
	assertId(pointId);
	const dir = join(recoveryRoot, projectId);
	if (!(await isRealDirectory(dir))) return;
	await rm(join(dir, `${pointId}.tar.zst`), { force: true });
	await rm(join(dir, `${pointId}.tar.zst.partial`), { force: true });
}

/** Remove every point of a project. `rm` removes a symlink, never its target. */
export async function deleteProjectRecoveryPoints(
	recoveryRoot: string,
	projectId: string,
): Promise<void> {
	assertId(projectId);
	await rm(join(recoveryRoot, projectId), { recursive: true, force: true });
}

/** A member name that stays inside the extraction directory. */
export function safeMemberName(name: string): boolean {
	return !name.startsWith("/") && !name.split("/").includes("..");
}

function assertId(id: string): void {
	if (!UUID.test(id)) {
		throw new AgentFailure("BAD_REQUEST", "invalid id");
	}
}

/**
 * The project's directory on the recovery volume, 0700. It must be a real
 * directory, so a symlink planted there cannot send archives elsewhere.
 */
async function pointDirectory(
	root: string,
	projectId: string,
	create: boolean,
): Promise<string> {
	if (!(await isRealDirectory(root))) {
		throw new AgentFailure("INTERNAL", "recovery storage is not available");
	}
	const dir = join(root, projectId);
	if (create) {
		try {
			await mkdir(dir, { mode: 0o700 });
		} catch (error) {
			if (isNoSpace(error)) {
				throw new AgentFailure("STORAGE_FULL", "recovery storage is full");
			}
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	}
	if (!(await isRealDirectory(dir))) {
		if (create) throw new AgentFailure("INTERNAL", "recovery storage is not usable");
		throw new AgentFailure("RECOVERY_POINT_INVALID", "no such recovery point");
	}
	return dir;
}

async function isRealDirectory(path: string): Promise<boolean> {
	try {
		return (await lstat(path)).isDirectory();
	} catch {
		return false;
	}
}

/** Run GNU tar over the listed paths, zstd-compress it, and hash what is written. */
async function writeArchive(
	cwd: string,
	entries: string[],
	destination: string,
): Promise<{ sizeBytes: number; sha256: string }> {
	const handle = await open(destination, "wx", 0o600);
	const child = spawn(
		"tar",
		[
			"--create",
			"--file=-",
			"--directory",
			cwd,
			"--no-recursion",
			"--null",
			"--no-unquote",
			"--verbatim-files-from",
			// A file deleted between the walk and tar is left out, not a failure.
			"--ignore-failed-read",
			"--files-from=-",
		],
		{ stdio: ["pipe", "pipe", "ignore"] },
	);
	const tap = hashingTap();
	child.stdin.on("error", () => {
		// tar exiting early is reported by its exit code.
	});
	child.stdin.end(entries.map((entry) => `${entry}\0`).join(""));
	const [written, exited] = await Promise.allSettled([
		pipeline(
			child.stdout,
			createZstdCompress(),
			tap.stream,
			handle.createWriteStream(),
		),
		exitCode(child),
	]);
	if (written.status === "rejected") {
		child.kill();
		throw written.reason;
	}
	if (exited.status === "rejected" || exited.value !== 0) {
		throw new AgentFailure("INTERNAL", "could not write the recovery point");
	}
	return { sizeBytes: tap.size(), sha256: tap.digest() };
}

/**
 * Stream the archive, hashing the compressed bytes, through zstd into tar
 * with the given arguments. The file is opened without following a link.
 * Any failure is `RECOVERY_POINT_INVALID`.
 */
async function readArchive(
	archive: string,
	tarArgs: string[],
): Promise<{ sha256: string; stdout: string }> {
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(archive, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch {
		throw new AgentFailure("RECOVERY_POINT_INVALID", "no such recovery point");
	}
	if (!(await handle.stat()).isFile()) {
		await handle.close();
		throw new AgentFailure("RECOVERY_POINT_INVALID", "no such recovery point");
	}
	const child = spawn("tar", [...tarArgs, "--file=-"], {
		stdio: ["pipe", "pipe", "ignore"],
	});
	let stdout = "";
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		stdout += chunk;
	});
	child.stdin.on("error", () => {
		// tar exiting early is reported by its exit code.
	});
	const tap = hashingTap();
	const [streamed, exited] = await Promise.allSettled([
		pipeline(
			handle.createReadStream(),
			tap.stream,
			createZstdDecompress(),
			child.stdin,
		),
		exitCode(child),
	]);
	if (streamed.status === "rejected") child.kill();
	if (
		streamed.status === "rejected" ||
		exited.status === "rejected" ||
		exited.value !== 0
	) {
		throw new AgentFailure(
			"RECOVERY_POINT_INVALID",
			"the recovery point could not be read",
		);
	}
	return { sha256: tap.digest(), stdout };
}

function hashingTap(): { stream: Transform; size: () => number; digest: () => string } {
	const hash = createHash("sha256");
	let size = 0;
	const stream = new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			hash.update(chunk);
			size += chunk.length;
			callback(null, chunk);
		},
	});
	return { stream, size: () => size, digest: () => hash.digest("hex") };
}

function exitCode(child: ChildProcess): Promise<number> {
	return new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code) => resolve(code ?? -1));
	});
}

/**
 * Delete every entry a point would hold: files and links are unlinked, never
 * followed, and a directory that still has excluded children is kept.
 */
async function clearIncluded(
	projectPath: string,
	dirRel: string,
	matcher: RecoveryMatcher,
): Promise<void> {
	const dir = dirRel === "" ? projectPath : join(projectPath, dirRel);
	for (const name of await readdir(dir)) {
		const rel = dirRel === "" ? name : `${dirRel}/${name}`;
		const path = join(projectPath, rel);
		const info = await lstat(path);
		if (info.isDirectory()) {
			if (matcher.excludes(`${rel}/`)) continue;
			await clearIncluded(projectPath, rel, matcher);
			try {
				await rmdir(path);
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
			}
		} else if (info.isFile() || info.isSymbolicLink()) {
			if (matcher.excludes(rel)) continue;
			await unlink(path);
		}
	}
}

/**
 * Move extracted entries into the project. A directory that exists on both
 * sides is merged, checked with `lstat` so a link is never entered; anything
 * else in the way is replaced by the archived entry.
 */
async function moveInto(from: string, to: string): Promise<void> {
	for (const name of await readdir(from)) {
		const source = join(from, name);
		const target = join(to, name);
		const sourceInfo = await lstat(source);
		const targetInfo = await lstat(target).catch(() => null);
		if (sourceInfo.isDirectory() && targetInfo?.isDirectory()) {
			await moveInto(source, target);
			await chmod(target, sourceInfo.mode & 0o7777);
			continue;
		}
		if (targetInfo) await rm(target, { recursive: true, force: true });
		await rename(source, target);
	}
}

function isMissing(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException).code;
	return code === "ENOENT" || code === "ENOTDIR";
}

function isNoSpace(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return code === "ENOSPC" || code === "EDQUOT";
}
