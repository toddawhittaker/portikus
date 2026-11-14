import { basename, extname } from "node:path";
import type { ChatAttachment } from "@portikus/contracts";
import { AgentFailure } from "../../errors.js";
import { resolveInProject } from "../../files.js";
import { isImagePath, promptBody } from "../attachments.js";

/** One piece of a Codex turn's input. */
export type CodexInput =
	| { type: "text"; text: string; text_elements: [] }
	| { type: "localImage"; path: string };

/**
 * A message as Codex's turn input. Each path is resolved inside the chat's
 * project, symlinks followed, and refused if it leaves it (SPEC.md §24.6).
 * Every file gets a line naming its path; images are also handed to Codex
 * by path, which it reads itself. SVG is refused because it can carry
 * script.
 */
export async function codexInput(
	homeDir: string,
	projectDir: string,
	text: string,
	attachments: readonly ChatAttachment[],
): Promise<CodexInput[]> {
	const paths: string[] = [];
	const images: CodexInput[] = [];
	for (const { path } of attachments) {
		const resolved = await resolveInProject(homeDir, basename(projectDir), path, {
			mustExist: true,
		});
		if (extname(path).toLowerCase() === ".svg") {
			throw new AgentFailure("BAD_REQUEST", "SVG images cannot be attached");
		}
		paths.push(path);
		if (isImagePath(path)) images.push({ type: "localImage", path: resolved.path });
	}
	const body = promptBody(text, paths);
	return [
		...(body === ""
			? []
			: [{ type: "text" as const, text: body, text_elements: [] as [] }]),
		...images,
	];
}
