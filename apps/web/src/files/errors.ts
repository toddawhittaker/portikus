/**
 * What the student is told when a file operation fails (SPEC.md §28): a
 * plain sentence for every code the file routes can return. The agent's own
 * message is never shown, because it is written for an administrator and can
 * carry paths the student has no use for (SPEC.md §24.6).
 */
import { MAX_UPLOAD_BYTES } from "@portikus/contracts";
import type { ToastProps } from "@portikus/ui";
import { ApiError } from "../api/request.js";

/** The upload cap in whole megabytes, for the messages that mention it. */
export const MAX_UPLOAD_MB = Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024));

export function tooLargeToast(): ToastProps {
	return {
		tone: "danger",
		title: `Files must be ${MAX_UPLOAD_MB} MB or smaller`,
	};
}

/** The sentence for each error code the file routes return. */
const MESSAGES: Record<string, string> = {
	FILE_NOT_FOUND: "That file is no longer there. The tree has been refreshed.",
	PATH_INVALID: "That path is not allowed.",
	NOT_A_DIRECTORY: "That is a file, not a folder.",
	AGENT_UNAVAILABLE: "The workspace is not responding. Try again in a moment.",
	FILE_EXISTS: "Something with that name already exists here",
	FILE_TOO_LARGE: `Files must be ${MAX_UPLOAD_MB} MB or smaller`,
};

/** True when the failure is an upload that clashed with an existing file. */
export function isFileExists(error: unknown): boolean {
	return error instanceof ApiError && error.code === "FILE_EXISTS";
}

export function fileErrorToast(error: unknown): ToastProps {
	if (error instanceof ApiError) {
		const message = error.code ? MESSAGES[error.code] : undefined;
		if (message) return { tone: "danger", title: message };
		if (error.status === 413) return tooLargeToast();
	}
	return {
		tone: "danger",
		title: "That did not work",
		children: "Something went wrong. Please try again.",
	};
}
