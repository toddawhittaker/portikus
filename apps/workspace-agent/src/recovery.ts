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
import { constants, type Dirent } from "node:fs";
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
} from "node:fs/promises";
import { join } from "node:path";
import { Transform, Writable } from "node:stream";
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
	const visit = async (dirRel: string, names: string[]): Promise<void> => {
		names.sort();
		for (const name of names) {
			const rel = dirRel === "" ? name : `${dirRel}/${name}`;
			let info: Awaited<ReturnType<typeof lstat>>;
			try {
				info = await lstat(join(projectPath, rel));
			} catch (error) {
				if (isMissing(error) || isDenied(error)) continue;
				throw error;
			}
			let type: "dir" | "file" | "link";
			let target: string | null = null;
			let children: string[] | null = null;
			if (info.isDirectory()) {
				if (matcher.excludes(`${rel}/`)) continue;
				// Unreadable (say a database's 0700 data directory) or removed while
				// walking: left out, as tar --ignore-failed-read leaves out a file.
				children = await readdirOrNull(join(projectPath, rel));
				if (children === null) continue;
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
			if (children !== null) await visit(rel, children);
		}
	};
	const top = await readdirOrNull(projectPath);
	if (top === null) throw new AgentFailure("PROJECT_NOT_FOUND", "no such project");
	await visit("", top);
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
	signal?: AbortSignal,
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
	signal?.throwIfAborted();
	const dir = await pointDirectory(paths.recoveryRoot, input.projectId, true);
	const final = join(dir, `${input.pointId}.tar.zst`);
	const partial = `${final}.partial`;
	try {
		const written = await writeArchive(project.path, walk.paths, partial, signal);
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

	// These names fail the slug pattern, so project discovery never lists them.
	const staging = join(projectsDir(paths.homeDir), `${STAGING_PREFIX}${input.pointId}`);
	const aside = join(projectsDir(paths.homeDir), `${ASIDE_PREFIX}${input.pointId}`);
	await rm(staging, { recursive: true, force: true });
	await rm(aside, { recursive: true, force: true });
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
		// The rules the point was made with decide what is replaced and kept.
		const matcher = await loadRecoveryMatcher(staging);
		await swapIn(project.path, staging, aside, matcher);
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

const STAGING_PREFIX = ".portikus-restore-";
const ASIDE_PREFIX = ".portikus-aside-";
const LEFTOVER =
	/^\.portikus-(restore|aside)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Remove staging and aside directories a crashed restore left in
 * `~/projects`: only real directories with exactly those names, and `rm`
 * never follows a link inside them. Returns how many were removed.
 */
export async function removeRestoreLeftovers(homeDir: string): Promise<number> {
	const root = projectsDir(homeDir);
	let entries: Dirent[];
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch (error) {
		if (isMissing(error)) return 0;
		throw error;
	}
	let removed = 0;
	for (const entry of entries) {
		if (!entry.isDirectory() || !LEFTOVER.test(entry.name)) continue;
		await rm(join(root, entry.name), { recursive: true, force: true });
		removed += 1;
	}
	return removed;
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
	signal?: AbortSignal,
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
		{ stdio: ["pipe", "pipe", "ignore"], signal },
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
	signal?.throwIfAborted();
	// GNU tar exits 1 when a file changed while it was read; the point is still whole.
	if (exited.status === "rejected" || exited.value > 1) {
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
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, LC_ALL: "C" },
	});
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		stdout += chunk;
	});
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => {
		// Only searched for the no-space message and never logged.
		stderr = (stderr + chunk).slice(-4096);
	});
	child.stdin.on("error", () => {
		// tar exiting early is reported by its exit code.
	});
	// tar may stop reading at the end-of-archive blocks, before the padding
	// after them. What it does not read is still hashed, then dropped.
	const toTar = new Writable({
		write(chunk: Buffer, _encoding, callback) {
			if (child.stdin.destroyed || child.stdin.writableEnded) return callback();
			child.stdin.write(chunk, () => callback());
		},
		final(callback) {
			child.stdin.end();
			callback();
		},
		destroy(error, callback) {
			// A stream that failed must still let tar see the end of its input.
			child.stdin.destroy();
			callback(error);
		},
	});
	const tap = hashingTap();
	const [streamed, exited] = await Promise.allSettled([
		pipeline(handle.createReadStream(), tap.stream, createZstdDecompress(), toTar),
		exitCode(child),
	]);
	if (streamed.status === "rejected") child.kill();
	if (
		streamed.status === "rejected" ||
		exited.status === "rejected" ||
		exited.value !== 0
	) {
		if (/No space left on device|Disk quota exceeded/.test(stderr)) {
			throw new AgentFailure("STORAGE_FULL", "there is not enough space to restore");
		}
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

/** One undoable step of a restore; undone in reverse order. */
type Step =
	| { kind: "moved"; from: string; to: string }
	| { kind: "removedDir"; path: string; mode: number }
	| { kind: "chmod"; path: string; mode: number };

/**
 * Replace the project's included entries with the staged ones. Current
 * entries are moved into `aside` (same filesystem), staged ones moved in,
 * and on any failure every step is undone. When the undo itself fails the
 * aside directory is kept and the error is `RESTORE_INCOMPLETE`.
 */
async function swapIn(
	projectPath: string,
	staging: string,
	aside: string,
	matcher: RecoveryMatcher,
): Promise<void> {
	const steps: Step[] = [];
	try {
		await mkdir(aside, { mode: 0o700 });
		await moveAside(projectPath, aside, "", matcher, steps);
		await moveInto(staging, projectPath, steps);
	} catch (error) {
		try {
			for (const step of steps.reverse()) await undo(step);
		} catch {
			throw new AgentFailure(
				"RESTORE_INCOMPLETE",
				"the project may be partly restored",
			);
		}
		await rm(aside, { recursive: true, force: true });
		if (isNoSpace(error)) {
			throw new AgentFailure("STORAGE_FULL", "there is not enough space to restore");
		}
		throw error;
	}
	await rm(aside, { recursive: true, force: true });
}

async function undo(step: Step): Promise<void> {
	if (step.kind === "moved") await rename(step.to, step.from);
	else if (step.kind === "removedDir") await mkdir(step.path, { mode: step.mode });
	else await chmod(step.path, step.mode);
}

/**
 * Move every entry a point would hold into `aside`. Files and links are
 * renamed, never followed. A directory that is excluded or unreadable is
 * kept as it is, and one that still has kept children stays in place.
 */
async function moveAside(
	projectPath: string,
	aside: string,
	dirRel: string,
	matcher: RecoveryMatcher,
	steps: Step[],
): Promise<void> {
	const names = await readdirOrNull(
		dirRel === "" ? projectPath : join(projectPath, dirRel),
	);
	if (names === null) return;
	for (const name of names) {
		const rel = dirRel === "" ? name : `${dirRel}/${name}`;
		const path = join(projectPath, rel);
		let info: Awaited<ReturnType<typeof lstat>>;
		try {
			info = await lstat(path);
		} catch (error) {
			if (isMissing(error) || isDenied(error)) continue;
			throw error;
		}
		if (info.isDirectory()) {
			if (matcher.excludes(`${rel}/`)) continue;
			if ((await readdirOrNull(path)) === null) continue;
			await mkdir(join(aside, rel), { mode: 0o700 });
			await moveAside(projectPath, aside, rel, matcher, steps);
			try {
				await rmdir(path);
				steps.push({ kind: "removedDir", path, mode: info.mode & 0o7777 });
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
			}
		} else if (info.isFile() || info.isSymbolicLink()) {
			if (matcher.excludes(rel)) continue;
			const to = join(aside, rel);
			await rename(path, to);
			steps.push({ kind: "moved", from: path, to });
		}
	}
}

/**
 * Move staged entries into the project. A directory on both sides is
 * merged, checked with `lstat` so a link is never entered. Anything else
 * still in the project was kept on purpose (excluded or unreadable), so it
 * wins over a same-named staged entry, such as a `build` file against an
 * excluded `build/` directory.
 */
async function moveInto(from: string, to: string, steps: Step[]): Promise<void> {
	for (const name of await readdir(from)) {
		const source = join(from, name);
		const target = join(to, name);
		const sourceInfo = await lstat(source);
		let targetInfo: Awaited<ReturnType<typeof lstat>> | null = null;
		try {
			targetInfo = await lstat(target);
		} catch (error) {
			if (!isMissing(error)) continue;
		}
		if (sourceInfo.isDirectory() && targetInfo?.isDirectory()) {
			await moveInto(source, target, steps);
			const mode = sourceInfo.mode & 0o7777;
			const was = targetInfo.mode & 0o7777;
			if (mode !== was) {
				await chmod(target, mode);
				steps.push({ kind: "chmod", path: target, mode: was });
			}
			continue;
		}
		if (targetInfo) continue;
		await rename(source, target);
		steps.push({ kind: "moved", from: source, to: target });
	}
}

/** A directory's names, or null when it is unreadable or gone. */
async function readdirOrNull(path: string): Promise<string[] | null> {
	try {
		return await readdir(path);
	} catch (error) {
		if (isMissing(error) || isDenied(error)) return null;
		throw error;
	}
}

function isDenied(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException).code;
	return code === "EACCES" || code === "EPERM";
}

function isMissing(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException).code;
	return code === "ENOENT" || code === "ENOTDIR";
}

function isNoSpace(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return code === "ENOSPC" || code === "EDQUOT";
}
