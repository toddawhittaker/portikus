/**
 * With auto-save off, text typed while a save is in flight is written at
 * once when the save answers, even if the keystroke has not rendered yet
 * (SPEC.md §13.5, version-aware writes).
 */
import type { EditorSettings } from "@portikus/contracts";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useFileBuffer } from "./useFileBuffer.js";

const mocks = vi.hoisted(() => ({ mutateAsync: vi.fn() }));

vi.mock("../files/queries.js", () => ({
	FileConflictError: class extends Error {},
	flushWrite: vi.fn(),
	useFile: () => ({
		data: { text: "a", etag: "v1", size: 1 },
		error: null,
		refetch: vi.fn(),
	}),
	useSaveFile: () => ({ mutateAsync: mocks.mutateAsync }),
}));

const settings = { autoSave: false, autoSaveDelaySeconds: 1 } as EditorSettings;

beforeEach(() => {
	vi.useFakeTimers();
	mocks.mutateAsync.mockReset();
});
afterEach(() => vi.useRealTimers());

it("saves keystrokes typed during a save, even before they render", async () => {
	const answers: Array<(value: { etag: string }) => void> = [];
	mocks.mutateAsync.mockImplementation(
		() => new Promise((resolve) => answers.push(resolve)),
	);
	const { result } = renderHook(() =>
		useFileBuffer({ workspaceId: "w", projectId: "p", path: "a.txt", settings }),
	);
	await act(async () => {});
	act(() => result.current.onChange("ab"));
	act(() => result.current.saveNow());
	expect(mocks.mutateAsync).toHaveBeenCalledTimes(1);

	// The keystroke and the save's answer land in the same batch.
	await act(async () => {
		result.current.onChange("abc");
		answers[0]?.({ etag: "v2" });
		await Promise.resolve();
		await Promise.resolve();
	});
	await act(async () => {
		await vi.advanceTimersByTimeAsync(0);
	});

	expect(mocks.mutateAsync).toHaveBeenCalledTimes(2);
	expect(mocks.mutateAsync.mock.calls[1]?.[0]).toEqual({ text: "abc", etag: "v2" });
});
