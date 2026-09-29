/**
 * "Extract here" for a zip in the Files pane (issue #817). The central
 * directory is read and checked before anything is written: every entry
 * must stay inside the new folder (SPEC.md §11.1, §24.6), and the entry
 * count and declared size are capped so a zip bomb is refused up front.
 * Info-ZIP unzip, already in the workspace image, does the extraction
 * under a per-file size limit, and a walk afterwards refuses any symbolic
 * link that points out of the folder. On any failure the folder is removed.
 */
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readlink, rm, statfs } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { MAX_EXTRACT_BYTES, MAX_EXTRACT_ENTRIES } from "@portikus/contracts";
import { resolveInProject } from "./files.js";
import { resolveProject } from "./projects.js";
import { AgentFailure } from "./tmux.js";

export interface ZipEntry {
	/** The stored name, with backslashes read as separators. */
	name: string;
	size: number;
	isDir: boolean;
	isSymlink: boolean;
	encrypted: boolean;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_BYTES = 22;
const MAX_COMMENT_BYTES = 0xffff;
/** Far more than 10,000 entries need; refuses a lying directory size. */
const MAX_CENTRAL_BYTES = 64 * 1024 * 1024;
const UNIX_HOST = 3;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

function invalid(message: string): AgentFailure {
	return new AgentFailure("ARCHIVE_INVALID", message);
}

/**
 * Read the zip's central directory. Zip64 archives are refused: their
 * sizes would not fit the caps anyway, and the plain format is all a
 * starter zip needs.
 */
export async function readZipEntries(file: string): Promise<ZipEntry[]> {
	const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const { size } = await handle.stat();
		const tailBytes = Math.min(size, EOCD_BYTES + MAX_COMMENT_BYTES);
		const tail = Buffer.alloc(tailBytes);
		await handle.read(tail, 0, tailBytes, size - tailBytes);
		let eocd = -1;
		for (let at = tailBytes - EOCD_BYTES; at >= 0; at--) {
			if (tail.readUInt32LE(at) === EOCD_SIGNATURE) {
				eocd = at;
				break;
			}
		}
		if (eocd < 0) throw invalid("not a zip file");
		const count = tail.readUInt16LE(eocd + 10);
		const centralSize = tail.readUInt32LE(eocd + 12);
		const centralOffset = tail.readUInt32LE(eocd + 16);
		if (
			count === 0xffff ||
			centralSize === 0xffffffff ||
			centralOffset === 0xffffffff
		) {
			throw invalid("zip64 archives are not supported");
		}
		if (count > MAX_EXTRACT_ENTRIES) {
			throw new AgentFailure("FILE_TOO_LARGE", "the zip holds too many entries");
		}
		if (centralSize > MAX_CENTRAL_BYTES || centralOffset + centralSize > size) {
			throw invalid("the zip is damaged");
		}
		const central = Buffer.alloc(centralSize);
		await handle.read(central, 0, centralSize, centralOffset);

		const entries: ZipEntry[] = [];
		let at = 0;
		for (let index = 0; index < count; index++) {
			if (at + 46 > central.length || central.readUInt32LE(at) !== CENTRAL_SIGNATURE) {
				throw invalid("the zip is damaged");
			}
			const host = central.readUInt8(at + 5);
			const flags = central.readUInt16LE(at + 8);
			const entrySize = central.readUInt32LE(at + 24);
			const nameLength = central.readUInt16LE(at + 28);
			const extraLength = central.readUInt16LE(at + 30);
			const commentLength = central.readUInt16LE(at + 32);
			const external = central.readUInt32LE(at + 38);
			const end = at + 46 + nameLength;
			if (end > central.length) throw invalid("the zip is damaged");
			// Only ASCII bytes matter to the checks, so latin1 reads them all.
			const name = central.toString("latin1", at + 46, end).replaceAll("\\", "/");
			if (entrySize === 0xffffffff) throw invalid("zip64 archives are not supported");
			entries.push({
				name,
				size: entrySize,
				isDir: name.endsWith("/"),
				isSymlink: host === UNIX_HOST && ((external >>> 16) & S_IFMT) === S_IFLNK,
				encrypted: (flags & 1) === 1,
			});
			at = end + extraLength + commentLength;
		}
		return entries;
	} catch (error) {
		if (error instanceof AgentFailure) throw error;
		throw invalid("the zip could not be read");
	} finally {
		await handle.close();
	}
}

/** A name that stays inside the folder it is extracted into. */
export function safeEntryName(name: string): boolean {
	if (name === "" || name.includes("\0")) return false;
	if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) return false;
	return !name.split("/").includes("..");
}

/**
 * Refuse the whole zip unless every entry is safe and it fits the caps.
 * An entry beneath a symbolic-link entry is refused too, since writing it
 * would go wherever the link points.
 */
export function checkEntries(entries: readonly ZipEntry[]): void {
	if (entries.length > MAX_EXTRACT_ENTRIES) {
		throw new AgentFailure("FILE_TOO_LARGE", "the zip holds too many entries");
	}
	let total = 0;
	const links = new Set<string>();
	for (const entry of entries) {
		if (!safeEntryName(entry.name)) throw invalid("the zip holds an unsafe path");
		if (entry.encrypted) throw invalid("the zip is password-protected");
		if (entry.isSymlink) links.add(entry.name.replace(/\/+$/, ""));
		total += entry.size;
	}
	if (total > MAX_EXTRACT_BYTES) {
		throw new AgentFailure("FILE_TOO_LARGE", "the zip unpacks to more than the cap");
	}
	for (const entry of entries) {
		const parts = entry.name.split("/");
		for (let depth = 1; depth < parts.length; depth++) {
			if (links.has(parts.slice(0, depth).join("/"))) {
				throw invalid("the zip writes through a symbolic link");
			}
		}
	}
}

/** The folder name for a zip: its name without `.zip`. */
export function folderNameFor(zipName: string): string {
	const stem = zipName.replace(/\.zip$/i, "");
	return stem === "" ? "archive" : stem;
}

function errorCode(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException).code;
}

function isNoSpace(error: unknown): boolean {
	const code = errorCode(error);
	return code === "ENOSPC" || code === "EDQUOT";
}

/**
 * Claim a new folder next to the zip. A taken name gets `-2`, `-3` and so
 * on, so an extraction never merges into a folder that already exists.
 */
async function claimFolder(parent: string, stem: string): Promise<string> {
	for (let n = 1; n <= 100; n++) {
		const name = n === 1 ? stem : `${stem}-${n}`;
		try {
			await mkdir(join(parent, name));
			return name;
		} catch (error) {
			if (errorCode(error) === "EEXIST") continue;
			if (isNoSpace(error)) {
				throw new AgentFailure("STORAGE_FULL", "no space left in the home folder");
			}
			throw error;
		}
	}
	throw new AgentFailure("FILE_EXISTS", "every folder name for this zip is taken");
}

/** Refuse any symbolic link in the folder whose target lies outside it. */
async function checkLinks(root: string, dir: string): Promise<void> {
	for (const dirent of await readdir(dir, { withFileTypes: true })) {
		const path = join(dir, dirent.name);
		if (dirent.isSymbolicLink()) {
			const target = await readlink(path);
			const lands = resolve(dirname(path), target);
			const rel = relative(root, lands);
			if (isAbsolute(target) || rel === ".." || rel.startsWith("../")) {
				throw invalid("the zip holds a symbolic link that leaves its folder");
			}
		} else if (dirent.isDirectory()) {
			await checkLinks(root, path);
		}
	}
}

/**
 * Run unzip on the already-open zip, inside `dest`. The zip is passed as
 * /proc/self/fd/3 so a name with wildcard characters is never matched as a
 * pattern and a swapped file is never read. prlimit caps each written file.
 */
function runUnzip(fd: number, dest: string): Promise<void> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(
			"prlimit",
			[`--fsize=${MAX_EXTRACT_BYTES}`, "--", "unzip", "-qq", "-n", "/proc/self/fd/3"],
			{
				cwd: dest,
				stdio: ["ignore", "ignore", "pipe", fd],
				env: { ...process.env, LC_ALL: "C" },
			},
		);
		let stderr = "";
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			// Only searched for the no-space message and never logged.
			stderr = (stderr + chunk).slice(-4096);
		});
		child.once("error", (error) => {
			reject(new AgentFailure("INTERNAL", `could not start unzip: ${error.message}`));
		});
		child.once("close", (code, signal) => {
			if (code === 0) return resolvePromise();
			if (signal === "SIGXFSZ") {
				reject(new AgentFailure("FILE_TOO_LARGE", "a file in the zip is over the cap"));
			} else if (
				/No space left on device|Disk quota exceeded|write error/i.test(stderr)
			) {
				reject(new AgentFailure("STORAGE_FULL", "no space left in the home folder"));
			} else {
				reject(invalid("the zip could not be extracted"));
			}
		});
	});
}

/**
 * Extract a project's zip into a new folder beside it and return that
 * folder's project-relative path.
 */
export async function extractZip(
	homeDir: string,
	slug: string,
	relPath: string,
): Promise<string> {
	const target = await resolveInProject(homeDir, slug, relPath, {
		mustExist: true,
		refuseSymlink: true,
	});
	if (!/\.zip$/i.test(target.path)) throw invalid("only .zip files can be extracted");
	const info = await lstat(target.path);
	if (!info.isFile()) throw invalid("only .zip files can be extracted");

	const entries = await readZipEntries(target.path);
	checkEntries(entries);
	const declared = entries.reduce((sum, entry) => sum + entry.size, 0);

	const parent = dirname(target.path);
	const space = await statfs(parent);
	if (space.bavail * space.bsize < declared) {
		throw new AgentFailure("STORAGE_FULL", "no space left in the home folder");
	}

	const project = await resolveProject(slug, homeDir);
	const name = await claimFolder(
		parent,
		folderNameFor(target.path.split("/").pop() ?? ""),
	);
	const dest = join(parent, name);
	const handle = await open(target.path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		await runUnzip(handle.fd, dest);
		await checkLinks(dest, dest);
	} catch (error) {
		// rm never follows a link, so a bad one is removed, not its target.
		await rm(dest, { recursive: true, force: true });
		if (isNoSpace(error)) {
			throw new AgentFailure("STORAGE_FULL", "no space left in the home folder");
		}
		throw error;
	} finally {
		await handle.close();
	}
	return relative(project.path, dest);
}
