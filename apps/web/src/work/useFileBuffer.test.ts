/**
 * The buffer's transitions, pinned to SPEC.md §13.3 (an outside change
 * refreshes clean text and is a conflict for edited text, never a silent
 * overwrite) and §13.5 (autosave, version-aware writes, clear save state).
 */
import { describe, expect, it } from "vitest";
import {
	type BufferAction,
	type BufferState,
	bufferReducer,
	INITIAL_BUFFER,
	isOwnVersion,
} from "./useFileBuffer.js";

function run(...actions: BufferAction[]): BufferState {
	return actions.reduce(bufferReducer, INITIAL_BUFFER);
}

const loaded: BufferAction = {
	type: "read",
	version: { etag: "v1", text: "a" },
	own: false,
	writing: false,
};

describe("bufferReducer", () => {
	it("fills the editor on the first load", () => {
		const state = run(loaded);
		expect(state).toMatchObject({
			text: "a",
			etag: "v1",
			status: "saved",
			dirty: false,
		});
	});

	it("refreshes clean text silently when the disk changes (§13.3)", () => {
		const state = run(loaded, {
			type: "read",
			version: { etag: "v2", text: "b" },
			own: false,
			writing: false,
		});
		expect(state).toMatchObject({
			text: "b",
			etag: "v2",
			status: "saved",
			conflict: null,
		});
	});

	it("turns an outside change under local edits into a conflict, keeping the text (§13.3)", () => {
		const state = run(
			loaded,
			{ type: "edit", text: "mine", inConflictView: false },
			{
				type: "read",
				version: { etag: "v2", text: "theirs" },
				own: false,
				writing: false,
			},
		);
		expect(state.text).toBe("mine");
		expect(state.status).toBe("conflict");
		expect(state.conflict).toEqual({ etag: "v2", text: "theirs" });
		expect(state.showConflict).toBe(true);
	});

	describe("own echo", () => {
		it("is not a conflict and adopts the etag when no write is in flight", () => {
			const state = run(
				loaded,
				{ type: "edit", text: "ab", inConflictView: false },
				{ type: "saveStart" },
				{ type: "edit", text: "abc", inConflictView: false },
				{
					type: "read",
					version: { etag: "v2", text: "ab" },
					own: true,
					writing: false,
				},
			);
			expect(state.conflict).toBeNull();
			expect(state.text).toBe("abc");
			expect(state.etag).toBe("v2");
		});

		it("keeps the etag while a write is in flight, since its answer is newer", () => {
			const state = run(
				loaded,
				{ type: "edit", text: "ab", inConflictView: false },
				{ type: "saveStart" },
				{ type: "edit", text: "abc", inConflictView: false },
				{ type: "read", version: { etag: "v2", text: "ab" }, own: true, writing: true },
			);
			expect(state.conflict).toBeNull();
			expect(state.etag).toBe("v1");
			expect(state.status).toBe("unsaved");
		});
	});

	describe("typing during a save (§13.5)", () => {
		it("marks only the sent text saved; newer keystrokes stay unsaved", () => {
			const state = run(
				loaded,
				{ type: "edit", text: "ab", inConflictView: false },
				{ type: "saveStart" },
				{ type: "edit", text: "abc", inConflictView: false },
				{ type: "saveDone", etag: "v2", sent: "ab" },
			);
			expect(state).toMatchObject({
				text: "abc",
				etag: "v2",
				dirty: true,
				status: "unsaved",
			});
		});

		it("is saved when nothing was typed meanwhile", () => {
			const state = run(
				loaded,
				{ type: "edit", text: "ab", inConflictView: false },
				{ type: "saveStart" },
				{ type: "saveDone", etag: "v2", sent: "ab" },
			);
			expect(state).toMatchObject({ dirty: false, status: "saved" });
		});
	});

	it("does not leave conflict status while the student types in a conflict", () => {
		const state = run(
			loaded,
			{ type: "edit", text: "mine", inConflictView: false },
			{ type: "conflict", version: { etag: "v2", text: "theirs" } },
			{ type: "edit", text: "mine!", inConflictView: true },
		);
		expect(state.status).toBe("conflict");
		expect(state.conflictEdits).toBe(1);
	});

	it("take disk replaces the text and clears the conflict", () => {
		const state = run(
			loaded,
			{ type: "edit", text: "mine", inConflictView: false },
			{ type: "conflict", version: { etag: "v2", text: "theirs" } },
			{ type: "takeDisk", version: { etag: "v2", text: "theirs" } },
		);
		expect(state).toMatchObject({
			text: "theirs",
			etag: "v2",
			dirty: false,
			conflict: null,
			showConflict: false,
			status: "saved",
		});
	});

	it("keep mine hides the diff and a successful save clears the conflict", () => {
		const state = run(
			loaded,
			{ type: "edit", text: "mine", inConflictView: false },
			{ type: "conflict", version: { etag: "v2", text: "theirs" } },
			{ type: "keepMine" },
		);
		expect(state.showConflict).toBe(false);
		const saved = bufferReducer(state, { type: "saveDone", etag: "v3", sent: "mine" });
		expect(saved).toMatchObject({ conflict: null, status: "saved" });
	});

	it("keeps a failed save's message through the next attempts, and clears it once a save succeeds", () => {
		const failed = run(
			loaded,
			{ type: "saveStart" },
			{ type: "saveFailed", message: "full" },
		);
		expect(failed).toMatchObject({ status: "failed", saveError: "full" });
		// Another autosave on a full disk: the same message stays, so it is not announced again.
		const retrying = bufferReducer(failed, { type: "saveStart" });
		expect(retrying).toMatchObject({ status: "saving", saveError: "full" });
		const again = bufferReducer(retrying, { type: "saveFailed", message: "full" });
		expect(again.saveError).toBe("full");
		const saved = bufferReducer(again, { type: "saveDone", etag: "v2", sent: "a" });
		expect(saved).toMatchObject({ status: "saved", saveError: null });
	});

	it("taking the version on disk drops a failed save's message", () => {
		const failed = run(
			loaded,
			{ type: "saveStart" },
			{ type: "saveFailed", message: "full" },
		);
		const taken = bufferReducer(failed, {
			type: "takeDisk",
			version: { etag: "v2", text: "theirs" },
		});
		expect(taken.saveError).toBeNull();
	});

	it("a file deleted on disk is marked, and a save recreates it", () => {
		const gone = run(loaded, { type: "deleted" });
		expect(gone.deleted).toBe(true);
		expect(
			bufferReducer(gone, { type: "saveDone", etag: "v2", sent: "a" }).deleted,
		).toBe(false);
	});
});

describe("isOwnVersion (false-conflict retry)", () => {
	it("is true for a version this tab loaded or wrote", () => {
		expect(isOwnVersion({ etag: "v1", text: "x" }, new Set(["v1"]), [])).toBe(true);
		expect(isOwnVersion({ etag: "v9", text: "ab" }, new Set(), ["a", "ab"])).toBe(true);
	});

	it("is false for someone else's edit, which must be a conflict", () => {
		expect(isOwnVersion({ etag: "v9", text: "theirs" }, new Set(["v1"]), ["ab"])).toBe(
			false,
		);
	});
});
