/**
 * "Extract here" for a zip in the Files pane. The central
 * directory is read and checked before anything is written: every entry
 * must stay inside the new folder (SPEC.md §11.1, §24.6), no entry may be
 * a symbolic link or touch `.git`, and the entry count and declared size
 * are capped so a zip bomb is refused up front. Info-ZIP unzip, already in
 * the workspace image, does the extraction under a per-file size limit
 * while free space is watched, since headers can lie about sizes. A walk
 * afterwards refuses any link that got through anyway. On any failure the
 * folder is removed.
 */
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
	type FileHandle,
	lstat,
	mkdir,
	open,
	readdir,
	rm,
	statfs,
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import {
	type ExtractProgress,
	MAX_EXTRACT_BYTES,
	MAX_EXTRACT_ENTRIES,
} from "@portikus/contracts";
import { AgentFailure, errorCode, isNoSpace, saysNoSpace } from "./errors.js";
import { resolveInProject } from "./files.js";
import { resolveProject } from "./projects.js";

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
const UNICODE_PATH_EXTRA = 0x7075;
/** How far past the cap free space may fall before unzip is stopped. */
const SPACE_MARGIN_BYTES = 16 * 1024 * 1024;
const SPACE_POLL_MS = 1000;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

/** Each running extraction's progress, by project slug (SPEC.md §11.2). */
const progress = new Map<string, ExtractProgress>();

/** How far the project's running extraction has got; total 0 when none runs. */
export function extractProgress(slug: string): ExtractProgress {
	return { ...(progress.get(slug) ?? { done: 0, total: 0 }) };
}

/**
 * unzip prints one line per entry it writes. Only the count is kept: the
 * names are student content and are never logged (STACK.md §15, ADR 0012).
 */
const ENTRY_LINE = /^\s*(creating|inflating|extracting|linking):/;

/** Count unzip's per-entry lines across chunks that may split a line. */
export function entryCounter(onEntry: () => void): (chunk: string) => void {
	let partial = "";
	return (chunk) => {
		const lines = (partial + chunk).split("\n");
		partial = lines.pop() ?? "";
		for (const line of lines) if (ENTRY_LINE.test(line)) onEntry();
	};
}

function invalid(message: string): AgentFailure {
	return new AgentFailure("ARCHIVE_INVALID", message);
}

/**
 * True when an extra-field block holds a Unicode path (0x7075) that names
 * something other than the header name, which unzip would use instead.
 */
function unicodePathDiffers(extra: Buffer, headerName: Buffer): boolean {
	let at = 0;
	while (at + 4 <= extra.length) {
		const tag = extra.readUInt16LE(at);
		const size = extra.readUInt16LE(at + 2);
		const body = extra.subarray(at + 4, at + 4 + size);
		// Version (1 byte) and a CRC of the header name (4) come first.
		if (tag === UNICODE_PATH_EXTRA && !body.subarray(5).equals(headerName)) return true;
		at += 4 + size;
	}
	return false;
}

/**
 * Read the zip's central directory from an open handle. Zip64 archives
 * are refused: their sizes would not fit the caps anyway, and the plain
 * format is all a starter zip needs.
 */
export async function readZipEntries(handle: FileHandle): Promise<ZipEntry[]> {
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
			const flags = central.readUInt16LE(at + 8);
			const entrySize = central.readUInt32LE(at + 24);
			const nameLength = central.readUInt16LE(at + 28);
			const extraLength = central.readUInt16LE(at + 30);
			const commentLength = central.readUInt16LE(at + 32);
			const external = central.readUInt32LE(at + 38);
			const end = at + 46 + nameLength;
			if (end + extraLength > central.length) throw invalid("the zip is damaged");
			const extra = central.subarray(end, end + extraLength);
			if (unicodePathDiffers(extra, central.subarray(at + 46, end))) {
				throw invalid("the zip holds a second, different name for an entry");
			}
			// Only ASCII bytes matter to the checks, so latin1 reads them all.
			const name = central.toString("latin1", at + 46, end).replaceAll("\\", "/");
			if (entrySize === 0xffffffff) throw invalid("zip64 archives are not supported");
			entries.push({
				name,
				size: entrySize,
				isDir: name.endsWith("/"),
				// unzip makes links for several made-by hosts, so the host is ignored.
				isSymlink: ((external >>> 16) & S_IFMT) === S_IFLNK,
				encrypted: (flags & 1) === 1,
			});
			at = end + extraLength + commentLength;
		}
		// unzip keeps reading central entries past the stored count, so any
		// bytes left over could hide entries from every check here.
		if (at !== centralSize || centralOffset + centralSize !== size - tailBytes + eocd) {
			throw invalid("the zip is damaged");
		}
		return entries;
	} catch (error) {
		if (error instanceof AgentFailure) throw error;
		throw invalid("the zip could not be read");
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
 * Starter zips need no links, so every symbolic link is refused, and so is
 * any `.git` path part (Git's own rule), which could plant a hook or config.
 */
export function checkEntries(entries: readonly ZipEntry[]): void {
	if (entries.length > MAX_EXTRACT_ENTRIES) {
		throw new AgentFailure("FILE_TOO_LARGE", "the zip holds too many entries");
	}
	let total = 0;
	for (const entry of entries) {
		if (!safeEntryName(entry.name)) throw invalid("the zip holds an unsafe path");
		if (entry.encrypted) throw invalid("the zip is password-protected");
		if (entry.isSymlink) throw invalid("the zip holds a symbolic link");
		if (entry.name.split("/").some((part) => part.toLowerCase() === ".git")) {
			throw invalid("the zip writes into a .git folder");
		}
		total += entry.size;
	}
	if (total > MAX_EXTRACT_BYTES) {
		throw tooLarge();
	}
}

/** The folder name for a zip: its name without `.zip`, never `.git`. */
export function folderNameFor(zipName: string): string {
	const stem = zipName.replace(/\.zip$/i, "");
	if (stem === "") return "archive";
	return stem.toLowerCase() === ".git" ? "git-archive" : stem;
}

function tooLarge(): AgentFailure {
	return new AgentFailure("FILE_TOO_LARGE", "the zip unpacks to more than the cap");
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

/**
 * Refuse any symbolic link or `.git` part at all in the extracted folder,
 * and return the bytes it holds. The exact total catches a fast unzip that
 * finished between free-space polls.
 */
export async function checkExtracted(dir: string): Promise<number> {
	let total = 0;
	for (const dirent of await readdir(dir, { withFileTypes: true })) {
		const path = join(dir, dirent.name);
		if (dirent.isSymbolicLink()) throw invalid("the zip holds a symbolic link");
		if (dirent.name.toLowerCase() === ".git") {
			throw invalid("the zip writes into a .git folder");
		}
		if (dirent.isDirectory()) total += await checkExtracted(path);
		else total += (await lstat(path)).size;
	}
	return total;
}

/**
 * Run unzip on the already-open zip, inside `dest`. The zip is passed as
 * /proc/self/fd/3 so a name with wildcard characters is never matched as a
 * pattern and a swapped file is never read. prlimit caps each written file;
 * a free-space watch caps the total, since sizes in headers can lie. unzip
 * runs in its own process group so a kill stops it whole.
 */
async function runUnzip(
	fd: number,
	dest: string,
	onEntry: () => void,
	signal?: AbortSignal,
): Promise<void> {
	const startFree = await freeBytes(dest);
	return new Promise((resolvePromise, reject) => {
		const child = spawn(
			"prlimit",
			[`--fsize=${MAX_EXTRACT_BYTES}`, "--", "unzip", "-n", "/proc/self/fd/3"],
			{
				cwd: dest,
				detached: true,
				stdio: ["ignore", "pipe", "pipe", fd],
				env: { ...process.env, LC_ALL: "C" },
			},
		);
		let stopped: AgentFailure | null = null;
		// Once unzip has exited its pid may be reused, so never signal it.
		let closed = false;
		const stop = (failure: AgentFailure) => {
			if (stopped || closed) return;
			stopped = failure;
			try {
				if (child.pid) process.kill(-child.pid, "SIGKILL");
			} catch {
				// Already gone.
			}
		};
		const timer = setInterval(() => {
			void freeBytes(dest).then(
				(free) => {
					if (startFree - free > MAX_EXTRACT_BYTES + SPACE_MARGIN_BYTES) {
						stop(tooLarge());
					}
				},
				() => {},
			);
		}, SPACE_POLL_MS);
		const onAbort = () => stop(new AgentFailure("INTERNAL", "the request was aborted"));
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) onAbort();

		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", entryCounter(onEntry));
		let stderr = "";
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			// Only searched for the no-space message and never logged.
			stderr = (stderr + chunk).slice(-4096);
		});
		const finish = () => {
			closed = true;
			clearInterval(timer);
			signal?.removeEventListener("abort", onAbort);
		};
		child.once("error", (error) => {
			finish();
			reject(new AgentFailure("INTERNAL", `could not start unzip: ${error.message}`));
		});
		child.once("close", (code, exitSignal) => {
			finish();
			if (stopped) {
				reject(stopped);
			} else if (code === 0) {
				resolvePromise();
			} else if (exitSignal === "SIGXFSZ") {
				reject(new AgentFailure("FILE_TOO_LARGE", "a file in the zip is over the cap"));
			} else if (saysNoSpace(stderr) || /write error/i.test(stderr)) {
				reject(new AgentFailure("STORAGE_FULL", "no space left in the home folder"));
			} else {
				reject(invalid("the zip could not be extracted"));
			}
		});
	});
}

async function freeBytes(path: string): Promise<number> {
	const space = await statfs(path);
	return space.bavail * space.bsize;
}

/**
 * Extract a project's zip into a new folder beside it and return that
 * folder's project-relative path. Aborting `signal` stops unzip.
 */
export async function extractZip(
	homeDir: string,
	slug: string,
	relPath: string,
	signal?: AbortSignal,
): Promise<string> {
	const target = await resolveInProject(homeDir, slug, relPath, {
		mustExist: true,
		refuseSymlink: true,
	});
	if (!/\.zip$/i.test(target.path)) throw invalid("only .zip files can be extracted");
	const project = await resolveProject(slug, homeDir);
	// One handle for the checks and for unzip, so the bytes checked are the
	// bytes extracted.
	// O_NONBLOCK keeps a FIFO named .zip from hanging the open.
	const handle = await open(
		target.path,
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	let dest: string | null = null;
	try {
		if (!(await handle.stat()).isFile()) {
			throw invalid("only .zip files can be extracted");
		}
		const entries = await readZipEntries(handle);
		checkEntries(entries);
		const declared = entries.reduce((sum, entry) => sum + entry.size, 0);
		const parent = dirname(target.path);
		if ((await freeBytes(parent)) < declared) {
			throw new AgentFailure("STORAGE_FULL", "no space left in the home folder");
		}
		const name = await claimFolder(
			parent,
			folderNameFor(target.path.split("/").pop() ?? ""),
		);
		dest = join(parent, name);
		const state = { done: 0, total: entries.length };
		progress.set(slug, state);
		// A header can claim fewer entries than unzip reports, so the count stops at the total.
		await runUnzip(
			handle.fd,
			dest,
			() => {
				state.done = Math.min(state.done + 1, state.total);
			},
			signal,
		);
		if ((await checkExtracted(dest)) > MAX_EXTRACT_BYTES) throw tooLarge();
		return relative(project.path, dest);
	} catch (error) {
		// rm never follows a link, so a bad one is removed, not its target.
		if (dest) await rm(dest, { recursive: true, force: true });
		if (isNoSpace(error)) {
			throw new AgentFailure("STORAGE_FULL", "no space left in the home folder");
		}
		throw error;
	} finally {
		progress.delete(slug);
		await handle.close();
	}
}
