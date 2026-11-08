/**
 * Read one local image for an assistant reply (SPEC.md §24.1). The path is
 * project-relative or absolute; either way its real path must stay inside
 * the student's home folder, so a symlink cannot reach anything else. Only
 * png, jpeg, gif and webp up to the chat image cap are served, and the
 * bytes must agree with the extension, so a renamed SVG or HTML file is
 * refused.
 */
import { constants as fsConstants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { join } from "node:path";
import {
	ChatImagePath,
	chatImageType,
	MAX_CHAT_IMAGE_BYTES,
} from "@portikus/contracts";
import { AgentFailure, errorCode } from "./errors.js";
import { resolveProject } from "./projects.js";

/** The type the first bytes of a file show it to be, or null for anything else. */
export function sniffImageType(head: Uint8Array): string | null {
	const starts = (bytes: number[], at = 0) =>
		bytes.every((byte, index) => head[at + index] === byte);
	if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
	if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
	if (starts([0x47, 0x49, 0x46, 0x38])) return "image/gif";
	// "RIFF", four length bytes, then "WEBP".
	if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) {
		return "image/webp";
	}
	return null;
}

function contains(root: string, path: string): boolean {
	return path === root || path.startsWith(`${root}/`);
}

export interface ChatImage {
	contentType: string;
	body: Buffer;
}

export async function readChatImage(
	homeDir: string,
	slug: string,
	path: string,
): Promise<ChatImage> {
	if (!ChatImagePath.safeParse(path).success) {
		throw new AgentFailure("PATH_INVALID", "invalid path");
	}
	const declared = chatImageType(path);
	if (declared === null) {
		throw new AgentFailure("BAD_REQUEST", "not an image chat can show");
	}
	const project = await resolveProject(slug, homeDir);
	if (!project.exists) {
		throw new AgentFailure("PROJECT_NOT_FOUND", "no such project");
	}
	const requested = path.startsWith("/") ? path : join(project.path, path);
	let real: string;
	try {
		real = await realpath(requested);
	} catch (error) {
		if (errorCode(error) === "ENOENT") {
			throw new AgentFailure("FILE_NOT_FOUND", "no such file");
		}
		throw new AgentFailure("PATH_INVALID", "invalid path");
	}
	if (!contains(await realpath(homeDir), real)) {
		throw new AgentFailure("PATH_INVALID", "path leaves the home folder");
	}
	// The real path has no links left, so O_NOFOLLOW refuses one swapped in
	// since. O_NONBLOCK keeps a named pipe from holding a thread until a
	// writer appears; a regular file ignores it.
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(
			real,
			fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
		);
	} catch {
		throw new AgentFailure("PATH_INVALID", "invalid path");
	}
	try {
		const info = await handle.stat();
		if (!info.isFile()) throw new AgentFailure("BAD_REQUEST", "not a regular file");
		if (info.size > MAX_CHAT_IMAGE_BYTES) {
			throw new AgentFailure("FILE_TOO_LARGE", "that image is too large");
		}
		// Read one byte past the stat size, so a file that grew since is caught.
		const buffer = Buffer.alloc(info.size + 1);
		let length = 0;
		while (length < buffer.length) {
			const { bytesRead } = await handle.read(buffer, length, buffer.length - length);
			if (bytesRead === 0) break;
			length += bytesRead;
		}
		if (length > info.size) {
			throw new AgentFailure("BAD_REQUEST", "that image changed while it was read");
		}
		const body = buffer.subarray(0, length);
		if (sniffImageType(body) !== declared) {
			throw new AgentFailure("BAD_REQUEST", "not an image chat can show");
		}
		return { contentType: declared, body };
	} finally {
		await handle.close();
	}
}
