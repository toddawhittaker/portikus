/**
 * What the student is told when a file operation fails (SPEC.md §28): the
 * plain sentence first, the technical code only where an administrator
 * would look for it.
 */
import { MAX_UPLOAD_BYTES } from "@portikus/contracts";
import type { ToastProps } from "@portikus/ui";
import { ApiError } from "../api/request.js";

/** The upload cap in whole megabytes, for the messages that mention it. */
export const MAX_UPLOAD_MB = Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024));

export function tooLargeToast(): ToastProps {
	return {
		tone: "danger",
		title: `Files must be smaller than ${MAX_UPLOAD_MB} MB`,
	};
}

export function fileErrorToast(error: unknown): ToastProps {
	if (error instanceof ApiError) {
		if (error.code === "FILE_EXISTS") {
			return { tone: "danger", title: "A file with that name already exists" };
		}
		if (error.status === 413) return tooLargeToast();
		return { tone: "danger", title: "That did not work", children: error.message };
	}
	return {
		tone: "danger",
		title: "That did not work",
		children: "Something went wrong. Please try again.",
	};
}
