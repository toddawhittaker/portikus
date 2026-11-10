/**
 * File-name search for the composer's `@` menu (SPEC.md §11.1): the project's
 * file paths, `.gitignore` respected, that contain the typed text. The text
 * goes in a POST body, never the URL, so it stays out of access logs.
 */
import { FileNameSearchResponse } from "@portikus/contracts";
import { request } from "../api/request.js";

/** Most paths one search asks for; the menu shows them all. */
const FILE_MATCHES = 20;

export function searchFileNames(
	workspaceId: string,
	projectId: string,
	query: string,
	signal: AbortSignal,
): Promise<FileNameSearchResponse> {
	return request(
		FileNameSearchResponse,
		`/workspaces/${workspaceId}/projects/${projectId}/file-search`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ query, limit: FILE_MATCHES }),
			signal,
		},
	);
}
