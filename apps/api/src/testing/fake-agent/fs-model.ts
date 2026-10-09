import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { ProjectPath } from "@portikus/contracts";

/** One entry of the fake filesystem. Paths are `<slug>/<path inside it>`. */
/** `apparentSize` stands in for a file too large to hold, for the download cap. */
export type FakeNode =
	| { type: "file"; content: Buffer; apparentSize?: number }
	| { type: "dir" };

/** CRC-32 of a buffer, which a zip entry header must carry. */
function crc32(data: Buffer): number {
	let crc = 0xffffffff;
	for (const byte of data) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit += 1) {
			crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
		}
	}
	return (crc ^ 0xffffffff) >>> 0;
}

/**
 * A valid zip holding one stored (uncompressed) file, written by hand so the
 * fake agent needs no zip dependency.
 */
export function oneFileZip(name: string, contents: string): Buffer {
	const nameBytes = Buffer.from(name, "utf8");
	const data = Buffer.from(contents, "utf8");
	const sum = crc32(data);

	const local = Buffer.alloc(30);
	local.writeUInt32LE(0x04034b50, 0);
	local.writeUInt16LE(20, 4); // version needed
	local.writeUInt16LE(0, 6); // flags
	local.writeUInt16LE(0, 8); // stored
	local.writeUInt16LE(0, 10); // time
	local.writeUInt16LE(0, 12); // date
	local.writeUInt32LE(sum, 14);
	local.writeUInt32LE(data.length, 18);
	local.writeUInt32LE(data.length, 22);
	local.writeUInt16LE(nameBytes.length, 26);
	local.writeUInt16LE(0, 28); // extra length

	const central = Buffer.alloc(46);
	central.writeUInt32LE(0x02014b50, 0);
	central.writeUInt16LE(20, 4); // version made by
	central.writeUInt16LE(20, 6); // version needed
	central.writeUInt16LE(0, 8);
	central.writeUInt16LE(0, 10);
	central.writeUInt16LE(0, 12);
	central.writeUInt16LE(0, 14);
	central.writeUInt32LE(sum, 16);
	central.writeUInt32LE(data.length, 20);
	central.writeUInt32LE(data.length, 24);
	central.writeUInt16LE(nameBytes.length, 28);
	central.writeUInt16LE(0, 30); // extra
	central.writeUInt16LE(0, 32); // comment
	central.writeUInt16LE(0, 34); // disk
	central.writeUInt16LE(0, 36); // internal attributes
	central.writeUInt32LE(0, 38); // external attributes
	central.writeUInt32LE(0, 42); // offset of local header

	const centralSize = central.length + nameBytes.length;
	const centralOffset = local.length + nameBytes.length + data.length;

	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(0, 4);
	end.writeUInt16LE(0, 6);
	end.writeUInt16LE(1, 8);
	end.writeUInt16LE(1, 10);
	end.writeUInt32LE(centralSize, 12);
	end.writeUInt32LE(centralOffset, 16);
	end.writeUInt16LE(0, 20);

	return Buffer.concat([local, nameBytes, data, central, nameBytes, end]);
}

/**
 * The files of a stored or deflated zip, read from its central directory, so
 * the fake can extract what a test uploads. Directory entries
 * are skipped; addParents makes them.
 */
export function readZipFiles(zip: Buffer): { name: string; data: Buffer }[] {
	const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
	if (eocd < 0) throw new FakeFileError("ARCHIVE_INVALID", "not a zip file");
	const count = zip.readUInt16LE(eocd + 10);
	let at = zip.readUInt32LE(eocd + 16);
	const files: { name: string; data: Buffer }[] = [];
	for (let index = 0; index < count; index++) {
		const method = zip.readUInt16LE(at + 10);
		const compressed = zip.readUInt32LE(at + 20);
		const nameLength = zip.readUInt16LE(at + 28);
		const skip = zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
		const local = zip.readUInt32LE(at + 42);
		const name = zip.toString("utf8", at + 46, at + 46 + nameLength);
		at += 46 + nameLength + skip;
		if (name.startsWith("/") || name.split("/").includes("..")) {
			throw new FakeFileError("ARCHIVE_INVALID", "the zip holds an unsafe path");
		}
		if (name.endsWith("/")) continue;
		const start =
			local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
		const raw = zip.subarray(start, start + compressed);
		files.push({ name, data: method === 8 ? inflateRawSync(raw) : Buffer.from(raw) });
	}
	return files;
}

/** The status the real agent answers each file error with (its ERROR_STATUS). */
export const FILE_ERROR_STATUS: Record<string, number> = {
	BAD_REQUEST: 400,
	PATH_INVALID: 400,
	NOT_A_DIRECTORY: 400,
	PROJECT_NOT_FOUND: 404,
	FILE_NOT_FOUND: 404,
	FILE_EXISTS: 409,
	DIRECTORY_EXISTS: 409,
	FILE_CHANGED: 412,
	FILE_TOO_LARGE: 413,
	ARCHIVE_INVALID: 422,
};

/** A file operation the fake refuses, mirroring the agent's AgentFailure. */
export class FakeFileError extends Error {
	readonly code: string;
	readonly etag: string | undefined;

	constructor(code: string, message: string, etag?: string) {
		super(message);
		this.code = code;
		this.etag = etag;
	}
}

export function etagOf(content: Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

/** The same sniff the real agent does: a NUL byte early on means binary. */
export function contentTypeOf(content: Buffer): string {
	return content.subarray(0, 8 * 1024).includes(0)
		? "application/octet-stream"
		: "text/plain; charset=utf-8";
}

/** The map key of a path inside a project; the empty path is the project. */
export function nodeKey(slug: string, path: string): string {
	return path === "" ? slug : `${slug}/${path}`;
}

export function checkPath(path: string): void {
	if (path !== "" && !ProjectPath.safeParse(path).success) {
		throw new FakeFileError("PATH_INVALID", "invalid path");
	}
}

/** Mark every parent directory of a path as existing, the way mkdir -p does. */
export function addParents(
	tree: Map<string, FakeNode>,
	slug: string,
	path: string,
): void {
	const parts = path.split("/").slice(0, -1);
	let walked = "";
	for (const part of parts) {
		walked = walked === "" ? part : `${walked}/${part}`;
		tree.set(nodeKey(slug, walked), { type: "dir" });
	}
}

/** Drop a project directory and everything under it. */
export function removeTree(tree: Map<string, FakeNode>, slug: string): void {
	for (const key of [...tree.keys()]) {
		if (key === slug || key.startsWith(`${slug}/`)) tree.delete(key);
	}
}

/**
 * One directory under `~/projects` as the fake holds it. `directoryId` stands
 * in for the inode the real agent reports: a rename keeps the
 * same record, so the identity travels with the directory.
 */
export interface FakeDirectory {
	isGitRepo: boolean;
	/** Absent when a test seeded the map directly and does not care. */
	directoryId?: string;
}

let directoryIdCounter = 1000;
export function nextDirectoryId(): string {
	directoryIdCounter += 1;
	return String(directoryIdCounter);
}

/** Move (or copy) a project's whole subtree onto a new slug. */
export function rekeyTree(
	tree: Map<string, FakeNode>,
	from: string,
	to: string,
	options: { copy: boolean },
): void {
	for (const [key, value] of [...tree]) {
		if (key !== from && !key.startsWith(`${from}/`)) continue;
		const moved: FakeNode =
			value.type === "file"
				? { type: "file", content: Buffer.from(value.content) }
				: { type: "dir" };
		tree.set(`${to}${key.slice(from.length)}`, moved);
		if (!options.copy) tree.delete(key);
	}
}
