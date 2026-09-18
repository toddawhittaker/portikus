import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
	lstat,
	mkdir as mkdirFs,
	open,
	readdir,
	realpath,
	rename,
	rm,
	stat,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
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
	/** The project's real directory. */
	root: string;
	/** The target, with its parent directories already resolved. */
	path: string;
	exists: boolean;
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
 */
export async function resolveInProject(
	homeDir: string,
	slug: string,
	relPath: string,
	options: { mustExist: boolean },
): Promise<ResolvedPath> {
	const project = await resolveProject(slug, homeDir);
	if (!project.exists) {
		throw new AgentFailure("PROJECT_NOT_FOUND", "no such project");
	}
	const root = project.path;
	if (relPath === "") {
		return { root, path: root, exists: true };
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

	try {
		const real = await realpath(path);
		if (!contains(root, real)) {
			throw new AgentFailure("PATH_INVALID", "path leaves the project");
		}
		return { root, path, exists: true };
	} catch (error) {
		if (error instanceof AgentFailure) throw error;
		if (errorCode(error) !== "ENOENT") {
			// Fail closed: anything we cannot resolve is treated as an escape.
			throw new AgentFailure("PATH_INVALID", "invalid path");
		}
		if (options.mustExist) {
			throw new AgentFailure("FILE_NOT_FOUND", "no such file or directory");
		}
		return { root, path, exists: false };
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

/** List a directory: directories first, then everything else, alphabetical. */
export async function listDir(
	homeDir: string,
	slug: string,
	relPath: string,
): Promise<TreeResponse> {
	const target = await resolveInProject(homeDir, slug, relPath, { mustExist: true });
	let names: string[];
	try {
		names = await readdir(target.path);
	} catch (error) {
		if (errorCode(error) === "ENOTDIR") {
			throw new AgentFailure("NOT_A_DIRECTORY", "not a directory");
		}
		throw error;
	}
	const entries: TreeEntry[] = [];
	for (const name of names) {
		// lstat, so a symlink reports itself rather than what it points at.
		const info = await lstat(join(target.path, name)).catch(() => null);
		if (!info) continue;
		entries.push({
			name,
			type: entryType(info),
			size: info.size,
			mtimeMs: info.mtimeMs,
		});
	}
	entries.sort((a, b) => {
		const aDir = a.type === "dir" ? 0 : 1;
		const bDir = b.type === "dir" ? 0 : 1;
		if (aDir !== bDir) return aDir - bDir;
		return a.name.localeCompare(b.name);
	});
	const truncated = entries.length > MAX_TREE_ENTRIES;
	return {
		entries: truncated ? entries.slice(0, MAX_TREE_ENTRIES) : entries,
		truncated,
	};
}

export interface ReadFileResult {
	etag: string;
	contentType: string;
	size: number;
	/** Present unless the file was requested as a download. */
	body?: Buffer;
	/** Present only for a download, so any size can be sent. */
	stream?: Readable;
}

function etagOf(content: Buffer): string {
	return createHash("sha256").update(content).digest("hex");
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
 * streams instead, so any size can leave the workspace (SPEC.md §11.2).
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

	if (options.download) {
		const handle = await open(target.path, "r");
		let contentType: string;
		try {
			const sample = Buffer.alloc(Math.min(SNIFF_BYTES, info.size));
			await handle.read(sample, 0, sample.length, 0);
			contentType = sniffContentType(sample);
		} finally {
			await handle.close();
		}
		return {
			etag: await hashFile(target.path),
			contentType,
			size: info.size,
			stream: createReadStream(target.path),
		};
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
		etag: etagOf(body),
		contentType: sniffContentType(body.subarray(0, SNIFF_BYTES)),
		size: body.length,
		body,
	};
}

export interface WriteOptions {
	/** The etag the caller last saw; the write fails if the file moved on. */
	ifMatch?: string;
	/** The file must not exist yet. */
	ifNoneMatch?: boolean;
	/** An upload: streamed to disk and allowed up to MAX_UPLOAD_BYTES. */
	upload?: boolean;
}

/**
 * Write a file with a conditional guard, so a stale browser cannot overwrite
 * a newer version on disk (SPEC.md §13.5). Writes in place, because the
 * terminal and coding agents watch the same inode.
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
	const target = await resolveInProject(homeDir, slug, relPath, { mustExist: false });

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
		const current = await hashFile(target.path);
		if (current !== options.ifMatch) {
			throw new FileChanged(current);
		}
	}

	const limit = options.upload ? MAX_UPLOAD_BYTES : MAX_EDITOR_FILE_BYTES;
	const hash = createHash("sha256");
	let size = 0;
	let tooLarge = false;
	const out = createWriteStream(target.path, { flags: "w" });
	try {
		await pipeline(
			body,
			async function* (source: AsyncIterable<Buffer>) {
				for await (const chunk of source) {
					size += chunk.length;
					if (size > limit) {
						tooLarge = true;
						throw new AgentFailure("FILE_TOO_LARGE", "that file is too large");
					}
					hash.update(chunk);
					yield chunk;
				}
			},
			out,
		);
	} catch (error) {
		if (tooLarge) {
			// The partial write is not what the student asked for; drop it.
			await rm(target.path, { force: true });
		}
		throw error;
	}
	return { etag: hash.digest("hex"), size };
}

/** Create a directory. Its parent must already exist (SPEC.md §11.2). */
export async function mkdir(
	homeDir: string,
	slug: string,
	relPath: string,
): Promise<void> {
	const target = await resolveInProject(homeDir, slug, relPath, { mustExist: false });
	if (target.exists) {
		throw new AgentFailure("FILE_EXISTS", "that name is already taken");
	}
	await mkdirFs(target.path);
}

/** Move or rename inside one project; both ends are confined to it. */
export async function move(
	homeDir: string,
	slug: string,
	from: string,
	to: string,
): Promise<void> {
	const source = await resolveInProject(homeDir, slug, from, { mustExist: true });
	const target = await resolveInProject(homeDir, slug, to, { mustExist: false });
	if (target.exists) {
		throw new AgentFailure("FILE_EXISTS", "that name is already taken");
	}
	await rename(source.path, target.path);
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
	const target = await resolveInProject(homeDir, slug, relPath, { mustExist: true });
	const info = await lstat(target.path);
	if (info.isDirectory()) {
		await rm(target.path, { recursive: true, force: true });
		return;
	}
	await rm(target.path, { force: true });
}
