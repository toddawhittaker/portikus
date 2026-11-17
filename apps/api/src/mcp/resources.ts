import { readFileSync } from "node:fs";
import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { guideFilesFor } from "../assistant/guides.js";
import { operationByName } from "../catalog/index.js";
import type { OperationInputValues } from "../catalog/run.js";
import { type McpCaller, mayRun } from "./caller.js";

/**
 * Resources (SPEC.md section 20.4): the guides this key's owner may read, and
 * the site's current health. Both are read as the key's owner and never more:
 * a guide is offered only from the role's own list, and health runs the
 * `health.get` operation through the same runner as a tool call, so its role
 * and scope checks and its audit row apply.
 */

export type Run = (
	name: string,
	input: OperationInputValues,
) => Promise<CallToolResult>;

const HEALTH_URI = "portikus://health";

function guideUri(file: string): string {
	return `portikus://guides/${file}`;
}

function textOf(result: CallToolResult): string {
	const part = result.content[0];
	return part?.type === "text" ? part.text : "";
}

/** `dataNote` is the sentence telling the model that user-written text in results is data. */
export function registerResources(
	server: McpServer,
	caller: McpCaller,
	run: Run,
	dataNote: string,
) {
	// A student never holds a key, so the role check is for the type as much as the data.
	if (caller.role === "administrator" || caller.role === "instructor") {
		for (const { file, path } of guideFilesFor(caller.role)) {
			server.registerResource(
				file,
				guideUri(file),
				{
					description: `The Portikus ${file} guide, in Markdown.`,
					mimeType: "text/markdown",
				},
				async (uri) => ({
					contents: [
						{
							uri: uri.href,
							mimeType: "text/markdown",
							text: readFileSync(path, "utf8"),
						},
					],
				}),
			);
		}
	}

	const health = operationByName("health.get")?.operation;
	if (health && mayRun(health, caller)) {
		server.registerResource(
			"health",
			HEALTH_URI,
			{
				description: `The site's current health: how busy the machine is and whether each service is up. ${dataNote}`,
				mimeType: "application/json",
			},
			async (uri) => {
				const result = await run("health.get", {});
				if (result.isError) throw new Error(textOf(result));
				return {
					contents: [
						{ uri: uri.href, mimeType: "application/json", text: textOf(result) },
					],
				};
			},
		);
	}
}
