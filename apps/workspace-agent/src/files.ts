import { createHash, randomBytes } from "node:crypto";
import { createReadStream, type Dirent, constants as fsConstants } from "node:fs";
import {
	link,
	lstat,
	mkdir as mkdirFs,
	open,
	readdir,
	realpath,
	rename,
	rm,
	stat,
	unlink,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
	MAX_DOWNLOAD_BYTES,
	MAX_EDITOR_FILE_BYTES,
	MAX_TREE_ENTRIES,
	MAX_UPLOAD_BYTES,
	ProjectPath,
	type TreeEntry,
	type TreeResponse,
	type WriteFileResponse,
} from "@portikus/contracts";
import { resolveProject } from "./projects.js";
import { AgentFailure } from "./tmux.js";

/** How much of a file is sniffed for a NUL byte before it is called binary. */
const SNIFF_BYTES = 8 * 1024;

export const TEXT_CONTENT_TYPE = "text/plain; charset=utf-8";
export const BINARY_CONTENT_TYPE = "application/octet-stream";

/**
 * A stale conditional write. It carries the file's current etag so the route
 * can return it as an ETag header and the editor can recover (SPEC.md §13.5).
 */
export class FileChanged extends AgentFailure {
	readonly etag: string;

	constructor(etag: string) {
		super("FILE_CHANGED", "the file changed on disk since it was read");
		this.name = "FileChanged";
		this.etag = etag;
	}
}

export interface ResolvedPath {
	/** The target, with its parent directories already resolved. */
	path: string;
	exists: boolean;
	/** The final component is a symlink and was not followed. */
	isSymlink: boolean;
}

function contains(root: string, path: string): boolean {
	return path === root || path.startsWith(`${root}/`);
}

function errorCode(error: unknown): string | undefined {
	return typeof (error as { code?: unknown }).code === "string"
		? (error as { code: string }).code
		: undefined;
}

/**
 * The single gate for every file operation: resolve a project-relative path
 * and refuse anything that could leave the project directory, including a
 * symlink in the path or as the final component (SPEC.md §11.1, §24.6).
 * An empty path means the project directory itself.
 *
 * With refuseSymlink, a final component that is a symlink is refused even
 * when it dangles, because a write would otherwise create the link's target
 * outside the project. With linkOk, a final symlink is returned as itself, so
 * delete and move can act on the link rather than on what it points at.
 *
 * A hard link inside the project that points at a file outside it cannot be
 * detected by any path check. Confinement bounds the coding agent, not a
 * student with a shell in their own workspace (SPEC.md §24.6).
 */
export async function resolveInProject(
	homeDir: string,
	slug: string,
	relPath: string,
	options: { mustExist: boolean; refuseSymlink?: boolean; linkOk?: boolean },
): Promise<ResolvedPath> {
	const project = await resolveProject(slug, homeDir);
	if (!project.exists) {
		throw new AgentFailure("PROJECT_NOT_FOUND", "no such project");
	}
	const root = project.path;
	if (relPath === "") {
		return { path: root, exists: true, isSymlink: false };
	}
	if (!ProjectPath.safeParse(relPath).success) {
		throw new AgentFailure("PATH_INVALID", "invalid path");
	}

	const requested = join(root, relPath);
	let parent: string;
	try {
		parent = await realpath(dirname(requested));
	} catch (error) {
		if (errorCode(error) === "ENOENT") {
			throw new AgentFailure("FILE_NOT_FOUND", "no such file or directory");
		}
		throw new AgentFailure("PATH_INVALID", "invalid path");
	}
	if (!contains(root, parent)) {
		throw new AgentFailure("PATH_INVALID", "path leaves the project");
	}
	const path = join(parent, basename(requested));

	if (options.refuseSymlink || options.linkOk) {
		const self = await lstat(path).catch((error: unknown) => {
			if (errorCode(error) === "ENOENT") return null;
			throw new AgentFailure("PATH_INVALID", "invalid path");
		});
		if (self?.isSymbolicLink()) {
			if (options.refuseSymlink) {
				throw new AgentFailure("PATH_INVALID", "that name is a symbolic link");
			}
			// The link itself sits inside the project, so it can be removed or
			// renamed without ever resolving where it points (SPEC.md §24.6).
			return { path, exists: true, isSymlink: true };
		}
	}

	try {
		const real = await realpath(path);
		if (!contains(root, real)) {
			throw new AgentFailure("PATH_INVALID", "path leaves the project");
		}
		return { path, exists: true, isSymlink: false };
	} catch (error) {
		if (error instanceof AgentFailure) throw error;
		if (errorCode(error) !== "ENOENT") {
			// Fail closed: anything we cannot resolve is treated as an escape.
			throw new AgentFailure("PATH_INVALID", "invalid path");
		}
		if (options.mustExist) {
			throw new AgentFailure("FILE_NOT_FOUND", "no such file or directory");
		}
		return { path, exists: false, isSymlink: false };
	}
}

function entryType(entry: {
	isDirectory(): boolean;
	isFile(): boolean;
	isSymbolicLink(): boolean;
}) {
	if (entry.isSymbolicLink()) return "symlink" as const;
	if (entry.isDirectory()) return "dir" as const;
	if (entry.isFile()) return "file" as const;
	return "other" as const;
}

/** One collator for every listing; building one per sort call is slow. */
const NAME_ORDER = new Intl.Collator("en");

/** List a directory: directories first, then everything else, alphabetical. */
export async function listDir(
	homeDir: string,
	slug: string,
	relPath: string,
): Promise<TreeResponse> {
	const target = await resolveInProject(homeDir, slug, relPath, { mustExist: true });
	let dirents: Dirent[];
	try {
		// withFileTypes gives the kind without a stat call, so a huge
		// directory is sorted and cut down before anything is stat'ed.
		dirents = await readdir(target.path, { withFileTypes: true });
	} catch (error) {
		if (errorCode(error) === "ENOTDIR") {
			throw new AgentFailure("NOT_A_DIRECTORY", "not a directory");
		}
		throw error;
	}
	dirents.sort((a, b) => {
		const aDir = a.isDirectory() ? 0 : 1;
		const bDir = b.isDirectory() ? 0 : 1;
		if (aDir !== bDir) return aDir - bDir;
		return NAME_ORDER.compare(a.name, b.name);
	});
	const truncated = dirents.length > MAX_TREE_ENTRIES;
	const entries: TreeEntry[] = [];
	for (const dirent of dirents.slice(0, MAX_TREE_ENTRIES)) {
		// lstat, so a symlink reports itself rather than what it points at.
		const info = await lstat(join(target.path, dirent.name)).catch(() => null);
		if (!info) continue;
		entries.push({
			name: dirent.name,
			type: entryType(info),
			size: info.size,
			mtimeMs: info.mtimeMs,
		});
	}
	return { entries, truncated };
}

export interface ReadFileResult {
	/** Absent for a download: a large file is not hashed twice. */
	etag?: string;
	contentType: string;
	size: number;
	/** Present unless the file was requested as a download. */
	body?: Buffer;
	/** Present only for a download, so a large file is streamed. */
	stream?: Readable;
}

async function hashFile(path: string): Promise<string> {
	const hash = createHash("sha256");
	await pipeline(createReadStream(path), hash);
	return hash.digest("hex");
}

function sniffContentType(sample: Buffer): string {
	return sample.includes(0) ? BINARY_CONTENT_TYPE : TEXT_CONTENT_TYPE;
}

/**
 * Read a file. An editor read is capped at MAX_EDITOR_FILE_BYTES; a download
 * streams instead, up to MAX_DOWNLOAD_BYTES (SPEC.md §11.2, #399).
 */
export async function readFile(
	homeDir: string,
	slug: string,
	relPath: string,
	options: { download?: boolean } = {},
): Promise<ReadFileResult> {
	const target = await resolveInProject(homeDir, slug, relPath, { mustExist: true });
	const info = await stat(target.path);
	if (info.isDirectory()) {
		throw new AgentFailure("BAD_REQUEST", "that path is a directory");
	}
	// A FIFO or a device node would block the read forever, so only ordinary
	// files are served (SPEC.md §11.2).
	if (!info.isFile()) {
		throw new AgentFailure("BAD_REQUEST", "not a regular file");
	}

	if (options.download) {
		// One handle for both the size and the bytes, so Content-Length cannot
		// disagree with what the stream then sends.
		const handle = await open(target.path, "r");
		try {
			const current = await handle.stat();
			if (current.size > MAX_DOWNLOAD_BYTES) {
				throw new AgentFailure(
					"FILE_TOO_LARGE",
					"that download is over the size limit",
				);
			}
			const sample = Buffer.alloc(Math.min(SNIFF_BYTES, current.size));
			await handle.read(sample, 0, sample.length, 0);
			const stream = handle.createReadStream();
			stream.on("close", () => {
				void handle.close().catch(() => {});
			});
			return { contentType: sniffContentType(sample), size: current.size, stream };
		} catch (error) {
			await handle.close().catch(() => {});
			throw error;
		}
	}

	if (info.size > MAX_EDITOR_FILE_BYTES) {
		throw new AgentFailure("FILE_TOO_LARGE", "that file is too large to open here");
	}
	const handle = await open(target.path, "r");
	let body: Buffer;
	try {
		body = await handle.readFile();
	} finally {
		await handle.close();
	}
	return {
		etag: createHash("sha256").update(body).digest("hex"),
		contentType: sniffContentType(body.subarray(0, SNIFF_BYTES)),
		size: body.length,
		body,
	};
}

export interface WriteOptions {
	/**
	 * The etag the caller last saw; the write fails if the file moved on.
	 * "*" is the HTTP wildcard: any existing file will do, which is what a
	 * deliberate replace asks for (RFC 9110, SPEC.md §11.2).
	 */
	ifMatch?: string;
	/** The file must not exist yet. */
	ifNoneMatch?: boolean;
	/** An upload: streamed to disk and allowed up to MAX_UPLOAD_BYTES. */
	upload?: boolean;
}

/**
 * Write a file with a conditional guard, so a stale browser cannot overwrite
 * a newer version on disk (SPEC.md §13.5).
 *
 * The body streams into a temporary file in the same directory and is moved
 * over the target only once it has arrived whole. A failed save - over the
 * cap, a dropped connection, a stream error - must never lose the student's
 * file, so the target is never truncated before the body is known good
 * (SPEC.md §13.5). The temporary file is opened with O_EXCL and O_NOFOLLOW,
 * so no symlink can redirect the write outside the project (SPEC.md §24.6).
 */
export async function writeFile(
	homeDir: string,
	slug: string,
	relPath: string,
	body: Readable,
	options: WriteOptions,
): Promise<WriteFileResponse> {
	const conditions = (options.ifMatch ? 1 : 0) + (options.ifNoneMatch ? 1 : 0);
	if (conditions !== 1) {
		throw new AgentFailure(
			"BAD_REQUEST",
			"a write needs exactly one of If-Match or If-None-Match",
		);
	}
	const target = await resolveInProject(homeDir, slug, relPath, {
		mustExist: false,
		refuseSymlink: true,
	});

	let mode: number | undefined;
	if (options.ifNoneMatch) {
		if (target.exists) {
			throw new AgentFailure("FILE_EXISTS", "that file already exists");
		}
	} else {
		if (!target.exists) {
			throw new AgentFailure("FILE_NOT_FOUND", "no such file");
		}
		const info = await stat(target.path);
		if (info.isDirectory()) {
			throw new AgentFailure("BAD_REQUEST", "that path is a directory");
		}
		mode = info.mode & 0o7777;
		if (options.ifMatch !== "*") {
			const current = await hashFile(target.path);
			if (current !== options.ifMatch) {
				throw new FileChanged(current);
			}
		}
	}

	const limit = options.upload ? MAX_UPLOAD_BYTES : MAX_EDITOR_FILE_BYTES;
	const hash = createHash("sha256");
	let size = 0;
	const tmpPath = join(dirname(target.path), tempName(basename(target.path)));
	// O_EXCL: a name nobody else holds. O_NOFOLLOW: the kernel refuses even if
	// the name became a symlink since the check above (SPEC.md §24.6).
	const handle = await open(
		tmpPath,
		fsConstants.O_WRONLY |
			fsConstants.O_CREAT |
			fsConstants.O_EXCL |
			fsConstants.O_NOFOLLOW,
		0o644,
	);
	let closed = false;
	try {
		if (mode !== undefined) {
			// Keep executable bits and the like across the rename.
			await handle.chmod(mode);
		}
		// destroyOnReturn: false, so stopping at the cap leaves the request
		// stream alive and the route can still answer on it (SPEC.md §13.5).
		let overLimit = false;
		for await (const chunk of body.iterator({ destroyOnReturn: false })) {
			const buffer = chunk as Buffer;
			if (size + buffer.length > limit) {
				overLimit = true;
				break;
			}
			size += buffer.length;
			hash.update(buffer);
			await handle.write(buffer);
		}
		if (overLimit) {
			// Stop pulling bytes; the caller decides when to close the socket.
			body.pause();
			throw new AgentFailure("FILE_TOO_LARGE", "that file is too large");
		}
		await handle.close();
		closed = true;
		if (options.ifNoneMatch) {
			// link fails with EEXIST rather than replacing anything, so a file
			// that appeared while the body was in flight survives. It also
			// fails on a dangling symlink instead of following it
			// (SPEC.md §13.5, §24.6).
			try {
				await link(tmpPath, target.path);
			} catch (error) {
				if (errorCode(error) === "EEXIST") {
					throw new AgentFailure("FILE_EXISTS", "that file already exists");
				}
				throw error;
			}
			await unlink(tmpPath);
		} else if (options.ifMatch !== "*") {
			// Re-check just before the rename so a write that landed while the
			// body was in flight is not lost (SPEC.md §13.5).
			const current = await hashFile(target.path);
			if (current !== options.ifMatch) {
				throw new FileChanged(current);
			}
			await rename(tmpPath, target.path);
		} else {
			// "*" is the HTTP wildcard: any existing version will do.
			await rename(tmpPath, target.path);
		}
	} catch (error) {
		if (!closed) {
			await handle.close().catch(() => {});
		}
		// Nothing touched the target, so leaving the temp file behind is the
		// only damage a failure can do; remove it.
		await rm(tmpPath, { force: true });
		throw error;
	}
	return { etag: hash.digest("hex"), size };
}

/**
 * The temporary file's name. The random suffix adds 22 bytes, so the basename
 * is cut to 200 bytes first and a long name cannot overflow NAME_MAX.
 */
function tempName(base: string): string {
	let short = base;
	while (Buffer.byteLength(short) > 200) {
		short = short.slice(0, -1);
	}
	return `.${short}.portikus-${randomBytes(6).toString("hex")}`;
}

/** Create a directory. Its parent must already exist (SPEC.md §11.2). */
export async function mkdir(
	homeDir: string,
	slug: string,
	relPath: string,
): Promise<void> {
	const target = await resolveInProject(homeDir, slug, relPath, {
		mustExist: false,
		refuseSymlink: true,
	});
	if (target.exists) {
		throw new AgentFailure("FILE_EXISTS", "that name is already taken");
	}
	try {
		await mkdirFs(target.path);
	} catch (error) {
		// Something else may have taken the name since the check above.
		if (errorCode(error) === "EEXIST") {
			throw new AgentFailure("FILE_EXISTS", "that name is already taken");
		}
		throw error;
	}
}

/** Move or rename inside one project; both ends are confined to it. */
export async function move(
	homeDir: string,
	slug: string,
	from: string,
	to: string,
): Promise<void> {
	const source = await resolveInProject(homeDir, slug, from, {
		mustExist: true,
		linkOk: true,
	});
	const target = await resolveInProject(homeDir, slug, to, {
		mustExist: false,
		refuseSymlink: true,
	});
	if (target.exists) {
		throw new AgentFailure("FILE_EXISTS", "that name is already taken");
	}
	if (contains(source.path, target.path)) {
		throw new AgentFailure("BAD_REQUEST", "a directory cannot be moved into itself");
	}
	try {
		// rename acts on a final symlink itself, so a link is moved, not
		// followed. The destination could still be taken in the microseconds
		// after the check above; Node has no RENAME_NOREPLACE, so that race is
		// left open and reported as a conflict when the kernel notices it.
		await rename(source.path, target.path);
	} catch (error) {
		if (errorCode(error) === "EEXIST" || errorCode(error) === "ENOTEMPTY") {
			throw new AgentFailure("FILE_EXISTS", "that name is already taken");
		}
		throw error;
	}
}

/** Delete a file or directory. A final symlink is removed, never followed. */
export async function remove(
	homeDir: string,
	slug: string,
	relPath: string,
): Promise<void> {
	if (relPath === "") {
		throw new AgentFailure("PATH_INVALID", "the project itself cannot be deleted here");
	}
	const target = await resolveInProject(homeDir, slug, relPath, {
		mustExist: true,
		linkOk: true,
	});
	if (target.isSymlink) {
		// The link is removed, never what it points at (SPEC.md §24.6).
		await unlink(target.path);
		return;
	}
	const info = await lstat(target.path);
	if (info.isDirectory()) {
		await rm(target.path, { recursive: true, force: true });
		return;
	}
	await rm(target.path, { force: true });
}
