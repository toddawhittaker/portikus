import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import {
	type ChatAttachment,
	type ChatImageMediaType,
	MAX_CHAT_IMAGE_BYTES,
} from "@portikus/contracts";
import { AgentFailure } from "../errors.js";
import { resolveInProject } from "../files.js";

const IMAGE_TYPES: Record<string, ChatImageMediaType> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
};

/** The first bytes of each image type, so a renamed file is not sent as an image. */
function looksLike(mediaType: ChatImageMediaType, data: Buffer): boolean {
	switch (mediaType) {
		case "image/png":
			return data.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
		case "image/jpeg":
			return data.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"));
		case "image/gif":
			return data.subarray(0, 4).toString("latin1") === "GIF8";
		case "image/webp":
			return (
				data.subarray(0, 4).toString("latin1") === "RIFF" &&
				data.subarray(8, 12).toString("latin1") === "WEBP"
			);
	}
}

export type UserContentBlock =
	| { type: "text"; text: string }
	| {
			type: "image";
			source: { type: "base64"; media_type: ChatImageMediaType; data: string };
	  };

/**
 * The user message for one `send` (plan ruling 10). Each path is resolved
 * inside the chat's project, symlinks followed, and refused if it leaves
 * it (SPEC.md §24.6). Images become image blocks; any other file becomes a
 * line naming its path, which Claude can read itself. SVG is refused
 * because it can carry script.
 */
export async function userContent(
	homeDir: string,
	projectDir: string,
	text: string,
	attachments: readonly ChatAttachment[],
): Promise<UserContentBlock[]> {
	const images: UserContentBlock[] = [];
	const lines: string[] = [];
	for (const { path } of attachments) {
		const resolved = await resolveInProject(homeDir, basename(projectDir), path, {
			mustExist: true,
		});
		const extension = extname(path).toLowerCase();
		if (extension === ".svg") {
			throw new AgentFailure("BAD_REQUEST", "SVG images cannot be attached");
		}
		const mediaType = IMAGE_TYPES[extension];
		if (!mediaType) {
			lines.push(`Attached file: ${path}`);
			continue;
		}
		const info = await stat(resolved.path);
		if (!info.isFile() || info.size > MAX_CHAT_IMAGE_BYTES) {
			throw new AgentFailure("BAD_REQUEST", "image is too large to attach");
		}
		const data = await readFile(resolved.path);
		if (data.length > MAX_CHAT_IMAGE_BYTES || !looksLike(mediaType, data)) {
			throw new AgentFailure("BAD_REQUEST", "file is not the image its name says");
		}
		images.push({
			type: "image",
			source: { type: "base64", media_type: mediaType, data: data.toString("base64") },
		});
	}
	const body = [text, ...lines].filter((line) => line !== "").join("\n\n");
	return [...(body === "" ? [] : [{ type: "text" as const, text: body }]), ...images];
}
