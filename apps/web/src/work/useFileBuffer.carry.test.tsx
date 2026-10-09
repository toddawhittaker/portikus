/**
 * A file pane remounts when it moves into or out of a split, and when its
 * file is renamed or moved from the files pane. Unsaved text survives either,
 * with auto-save on or off (SPEC.md §13.5, §11.2).
 */
import type { EditorSettings } from "@portikus/contracts";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createLayoutStore,
	type LayoutStore,
	LayoutStoreContext,
} from "../layout/store.js";
import { useFileBuffer } from "./useFileBuffer.js";

const mocks = vi.hoisted(() => ({ mutateAsync: vi.fn(), flushWrite: vi.fn() }));

vi.mock("../files/queries.js", () => ({
	FileConflictError: class extends Error {},
	flushWrite: mocks.flushWrite,
	useFile: () => ({
		data: { text: "a", etag: "v1", size: 1 },
		error: null,
		refetch: vi.fn(),
	}),
	useSaveFile: () => ({ mutateAsync: mocks.mutateAsync }),
}));

const OFF = { autoSave: false, autoSaveDelaySeconds: 1 } as EditorSettings;
const ON = { autoSave: true, autoSaveDelaySeconds: 1 } as EditorSettings;

function mount(store: LayoutStore, path: string, settings: EditorSettings) {
	const wrapper = ({ children }: { children: ReactNode }) => (
		<LayoutStoreContext.Provider value={store}>{children}</LayoutStoreContext.Provider>
	);
	return renderHook(
		() => useFileBuffer({ workspaceId: "w", projectId: "p", path, settings }),
		{ wrapper },
	);
}

beforeEach(() => {
	vi.useFakeTimers();
	mocks.mutateAsync.mockReset();
	mocks.mutateAsync.mockResolvedValue({ etag: "v2" });
	mocks.flushWrite.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("unsaved text across a remount", () => {
	it("comes back unsaved, and unwritten, with auto-save off", async () => {
		const store = createLayoutStore();
		store.getState().openFile("a.txt");
		const first = mount(store, "a.txt", OFF);
		await act(async () => {});
		act(() => first.result.current.onChange("a edited"));
		first.unmount();

		const second = mount(store, "a.txt", OFF);
		await act(async () => {});
		expect(second.result.current.state.text).toBe("a edited");
		expect(second.result.current.state.status).toBe("unsaved");
		expect(mocks.flushWrite).not.toHaveBeenCalled();
		expect(mocks.mutateAsync).not.toHaveBeenCalled();
	});

	it("is written as it unmounts and still shown after, with auto-save on", async () => {
		const store = createLayoutStore();
		store.getState().openFile("a.txt");
		const first = mount(store, "a.txt", ON);
		await act(async () => {});
		act(() => first.result.current.onChange("a edited"));
		first.unmount();
		expect(mocks.flushWrite).toHaveBeenCalledWith("w", "p", "a.txt", "a edited", "v1");

		const second = mount(store, "a.txt", ON);
		await act(async () => {});
		expect(second.result.current.state.text).toBe("a edited");
	});

	it("is not kept for a file whose tab was closed", async () => {
		const store = createLayoutStore();
		store.getState().openFile("a.txt");
		const first = mount(store, "a.txt", OFF);
		await act(async () => {});
		act(() => first.result.current.onChange("a edited"));
		act(() => store.getState().closeFile("a.txt"));
		first.unmount();

		store.getState().openFile("a.txt");
		const second = mount(store, "a.txt", OFF);
		await act(async () => {});
		expect(second.result.current.state.text).toBe("a");
		expect(second.result.current.state.status).toBe("saved");
	});
});

describe("unsaved text across a rename", () => {
	for (const settings of [OFF, ON]) {
		const mode = settings.autoSave ? "on" : "off";
		it(`follows the file to its new path with auto-save ${mode}`, async () => {
			const store = createLayoutStore();
			store.getState().openFile("a.txt");
			const first = mount(store, "a.txt", settings);
			await act(async () => {});
			act(() => first.result.current.onChange("a edited"));
			act(() => store.getState().retargetTabs("a.txt", "b.txt"));
			first.unmount();
			// Nothing goes to the old path, which no longer exists.
			expect(mocks.flushWrite).not.toHaveBeenCalled();

			const second = mount(store, "b.txt", settings);
			await act(async () => {});
			expect(second.result.current.state.text).toBe("a edited");
			expect(second.result.current.state.dirty).toBe(true);
			await act(async () => {
				await vi.advanceTimersByTimeAsync(settings.autoSave ? 0 : 10_000);
			});
			if (settings.autoSave) {
				// The new mount saves it, against the version the edit started from.
				expect(mocks.mutateAsync).toHaveBeenCalledWith({
					text: "a edited",
					etag: "v1",
				});
			} else {
				expect(mocks.mutateAsync).not.toHaveBeenCalled();
			}
		});
	}
});
