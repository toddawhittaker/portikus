/**
 * A refused write whose refusal meets this tab's own text on disk is not a
 * conflict, even when the first read after the refusal is one that was
 * already in flight and still carries the version from before (SPEC.md §13.3,
 * §13.5). A remounting pane's last write and its next mount's save race this
 * way.
 */
import type { EditorSettings } from "@portikus/contracts";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useFileBuffer } from "./useFileBuffer.js";

const mocks = vi.hoisted(() => {
	class FileConflictError extends Error {
		constructor(readonly etag: string) {
			super("conflict");
		}
	}
	return { mutateAsync: vi.fn(), refetch: vi.fn(), FileConflictError };
});

vi.mock("../files/queries.js", () => ({
	FileConflictError: mocks.FileConflictError,
	flushWrite: vi.fn(),
	useFile: () => ({
		data: { text: "a", etag: "v1", size: 1 },
		error: null,
		refetch: mocks.refetch,
	}),
	useSaveFile: () => ({ mutateAsync: mocks.mutateAsync }),
}));

const settings = { autoSave: false, autoSaveDelaySeconds: 1 } as EditorSettings;

beforeEach(() => {
	mocks.mutateAsync.mockReset();
	mocks.refetch.mockReset();
});

function mount() {
	return renderHook(() =>
		useFileBuffer({ workspaceId: "w", projectId: "p", path: "a.txt", settings }),
	);
}

it("asks again past a stale read, and takes its own text on disk as saved", async () => {
	mocks.mutateAsync.mockRejectedValue(new mocks.FileConflictError("v2"));
	mocks.refetch
		// The read that was in flight: the version before the other write.
		.mockResolvedValueOnce({ data: { text: "a", etag: "v1", size: 1 } })
		.mockResolvedValueOnce({ data: { text: "ab", etag: "v2", size: 2 } });
	const { result } = mount();
	await act(async () => {});
	act(() => result.current.onChange("ab"));
	await act(async () => {
		result.current.saveNow();
	});

	expect(mocks.refetch).toHaveBeenCalledTimes(2);
	expect(mocks.mutateAsync).toHaveBeenCalledTimes(1);
	expect(result.current.state.status).toBe("saved");
	expect(result.current.state.conflict).toBeNull();
	expect(result.current.state.etag).toBe("v2");
});

it("still opens a conflict when the disk holds someone else's text", async () => {
	mocks.mutateAsync.mockRejectedValue(new mocks.FileConflictError("v3"));
	mocks.refetch.mockResolvedValue({ data: { text: "theirs", etag: "v3", size: 6 } });
	const { result } = mount();
	await act(async () => {});
	act(() => result.current.onChange("ab"));
	await act(async () => {
		result.current.saveNow();
	});

	expect(result.current.state.status).toBe("conflict");
	expect(result.current.state.conflict).toEqual({ etag: "v3", text: "theirs" });
	expect(result.current.state.text).toBe("ab");
});
