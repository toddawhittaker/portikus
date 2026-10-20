// Writing and reading a recovery point's tar and zstd archive, hashing the compressed bytes (SPEC.md §15, ADR 0020).
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createZstdCompress, createZstdDecompress } from "node:zlib";
import { AgentFailure } from "./errors.js";

/** Run GNU tar over the listed paths, zstd-compress it, and hash what is written. */
export async function writeArchive(
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

/** What one pass over an archive produced. */
export interface ArchiveRead {
	sha256: string;
	/** tar's output, cut at `maxStdoutBytes` when one was given. */
	stdout: Buffer;
	/** True when tar wrote more than `maxStdoutBytes`. */
	overflow: boolean;
	/** True when tar read the whole archive but a named member was not in it. */
	missingMember: boolean;
}

/**
 * Stream the archive, hashing the compressed bytes, through zstd into tar
 * with the given arguments. The file is opened without following a link.
 * Running past `timeoutMs` is `RECOVERY_READ_TIMEOUT`; any other failure is
 * `RECOVERY_POINT_INVALID`.
 */
export async function readArchive(
	archive: string,
	tarArgs: string[],
	limits: { maxStdoutBytes?: number; timeoutMs?: number } = {},
): Promise<ArchiveRead> {
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
	// First, so a `--` in tarArgs cannot turn it into a member name.
	const child = spawn("tar", ["--file=-", ...tarArgs], {
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, LC_ALL: "C" },
	});
	const cap = limits.maxStdoutBytes ?? Number.POSITIVE_INFINITY;
	const chunks: Buffer[] = [];
	let kept = 0;
	let overflow = false;
	let stderr = "";
	child.stdout.on("data", (chunk: Buffer) => {
		// Past the cap the rest is drained, not kept, so tar still reads the
		// whole archive and the hash still covers all of it.
		if (overflow) return;
		if (kept + chunk.length > cap) {
			chunks.push(chunk.subarray(0, cap - kept));
			kept = cap;
			overflow = true;
			return;
		}
		chunks.push(chunk);
		kept += chunk.length;
	});
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => {
		// Only searched for known messages and never logged.
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
	const stop = new AbortController();
	let timedOut = false;
	const timer =
		limits.timeoutMs === undefined
			? undefined
			: setTimeout(() => {
					timedOut = true;
					stop.abort();
					child.kill("SIGKILL");
				}, limits.timeoutMs);
	const [streamed, exited] = await Promise.allSettled([
		pipeline(handle.createReadStream(), tap.stream, createZstdDecompress(), toTar, {
			signal: stop.signal,
		}),
		exitCode(child),
	]);
	clearTimeout(timer);
	if (timedOut) {
		throw new AgentFailure(
			"RECOVERY_READ_TIMEOUT",
			"reading the recovery point took too long",
		);
	}
	if (streamed.status === "rejected") child.kill();
	const read: ArchiveRead = {
		sha256: tap.digest(),
		stdout: Buffer.concat(chunks),
		overflow,
		missingMember: false,
	};
	if (streamed.status === "fulfilled" && exited.status === "fulfilled") {
		if (exited.value === 0) return read;
		// GNU tar reads to the end, then exits 2 when a named member is absent.
		if (exited.value === 2 && /Not found in archive/.test(stderr)) {
			return { ...read, missingMember: true };
		}
	}
	if (/No space left on device|Disk quota exceeded/.test(stderr)) {
		throw new AgentFailure("STORAGE_FULL", "there is not enough space to restore");
	}
	throw new AgentFailure(
		"RECOVERY_POINT_INVALID",
		"the recovery point could not be read",
	);
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
