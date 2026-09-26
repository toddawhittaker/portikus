import { expect, test } from "vitest";
import { ApiError } from "../api/request.js";
import { fileErrorToast, isStorageFull, STORAGE_FULL_MESSAGE } from "./errors.js";

test("a full home folder tells the student what to do (SPEC.md §28)", () => {
	const error = new ApiError(507, "no space left in the home folder", "STORAGE_FULL");
	expect(isStorageFull(error)).toBe(true);
	expect(fileErrorToast(error).title).toBe(
		"Your home folder is full. Delete files, then try again.",
	);
	expect(STORAGE_FULL_MESSAGE).toBe(fileErrorToast(error).title);
	expect(isStorageFull(new ApiError(500, "x", "INTERNAL"))).toBe(false);
});
