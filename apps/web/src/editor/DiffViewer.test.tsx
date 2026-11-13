/**
 * The diff's zoom (SPEC.md §13.1): the same controls as the editor, one zoom
 * per file shared with the editor, applied to both sides of the diff. Monaco
 * is replaced by a fake that records what it was asked to do.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createLayoutStore, LayoutStoreContext } from "../layout/store.js";

const KEY = { CtrlCmd: 1, Shift: 2, Equal: 4, Minus: 8, Digit0: 16 };

const fake = vi.hoisted(() => ({
	options: [] as Record<string, unknown>[],
	updates: [] as Record<string, unknown>[],
	/** The keys each side was given, by side. */
	commands: { original: new Map(), modified: new Map() } as Record<
		"original" | "modified",
		Map<number, () => void>
	>,
}));

vi.mock("./settingsQueries.js", () => ({ useScreenReaderMode: () => false }));
vi.mock("./monaco.js", () => {
	const side = (which: "original" | "modified") => ({
		updateOptions: () => {},
		addCommand: (keys: number, run: () => void) => fake.commands[which].set(keys, run),
	});
	const monaco = {
		KeyMod: { CtrlCmd: 1, Shift: 2 },
		KeyCode: { Equal: 4, Minus: 8, Digit0: 16 },
		editor: {
			createModel: () => ({
				getValue: () => "",
				setValue: () => {},
				dispose: () => {},
			}),
			create: () => ({ dispose: () => {} }),
			createDiffEditor: (_host: unknown, options: Record<string, unknown>) => {
				fake.options.push(options);
				return {
					updateOptions: (next: Record<string, unknown>) => fake.updates.push(next),
					setModel: () => {},
					getOriginalEditor: () => side("original"),
					getModifiedEditor: () => side("modified"),
					saveViewState: () => null,
					restoreViewState: () => {},
					dispose: () => {},
				};
			},
		},
	};
	return {
		accessibilitySupport: () => "auto",
		baseEditorOptions: {},
		currentThemeName: () => "light",
		editorAriaLabel: () => "Diff",
		getMonaco: async () => monaco,
		languageForPath: () => "plaintext",
		watchTheme: () => {},
	};
});

const { DiffViewer } = await import("./DiffViewer");

beforeEach(() => {
	fake.options.length = 0;
	fake.updates.length = 0;
	fake.commands.original.clear();
	fake.commands.modified.clear();
});
afterEach(cleanup);

async function renderDiff(store = createLayoutStore()) {
	render(
		<LayoutStoreContext.Provider value={store}>
			<DiffViewer path="a.ts" original="1" modified="2" version="v" />
		</LayoutStoreContext.Provider>,
	);
	await vi.waitFor(() => expect(fake.options).toHaveLength(1));
	return store;
}

const zoomText = () => screen.getByTestId("diff-zoom-a.ts").textContent;

test("the diff has the editor's zoom controls and opens at the file's zoom", async () => {
	const store = createLayoutStore();
	store.getState().setZoom("a.ts", 130);
	await renderDiff(store);
	expect(zoomText()).toBe("130%");
	expect(screen.getByRole("button", { name: "Zoom out" })).toBeTruthy();
	expect(screen.getByRole("button", { name: "Zoom in" })).toBeTruthy();
	expect(screen.getByRole("button", { name: "Reset" })).toBeTruthy();
	// 14 px at 100%, so 130% is 18 px, for both sides together.
	expect(fake.options[0]?.fontSize).toBe(18);
});

test("zooming the diff changes the font size and the file's one zoom", async () => {
	const store = await renderDiff();
	fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
	expect(zoomText()).toBe("110%");
	expect(store.getState().zooms["a.ts"]).toBe(110);
	expect(fake.updates.at(-1)).toEqual({ fontSize: 15 });
	fireEvent.click(screen.getByRole("button", { name: "Reset" }));
	expect(store.getState().zooms["a.ts"]).toBe(100);
	expect(fake.updates.at(-1)).toEqual({ fontSize: 14 });
});

test("a zoom made in the editor shows in the diff", async () => {
	const store = await renderDiff();
	act(() => store.getState().setZoom("a.ts", 90));
	expect(zoomText()).toBe("90%");
	expect(fake.updates.at(-1)).toEqual({ fontSize: 13 });
});

test("both sides take the zoom keys", async () => {
	const store = await renderDiff();
	const zoomIn = KEY.CtrlCmd | KEY.Shift | KEY.Equal;
	const zoomOut = KEY.CtrlCmd | KEY.Shift | KEY.Minus;
	const reset = KEY.CtrlCmd | KEY.Digit0;
	for (const side of ["original", "modified"] as const) {
		const keys = fake.commands[side];
		expect([...keys.keys()].sort()).toEqual([zoomIn, zoomOut, reset].sort());
		act(() => keys.get(zoomIn)?.());
		expect(store.getState().zooms["a.ts"]).toBe(110);
		act(() => keys.get(zoomOut)?.());
		act(() => keys.get(zoomOut)?.());
		expect(store.getState().zooms["a.ts"]).toBe(90);
		act(() => keys.get(reset)?.());
		expect(store.getState().zooms["a.ts"]).toBe(100);
	}
});

test("Ctrl with the wheel zooms the diff and never the page", async () => {
	const store = await renderDiff();
	const host = screen.getByTestId("diff-editor-a.ts").querySelector(".pk-editor-host");
	const taken = !fireEvent.wheel(host as Element, { deltaY: -120, ctrlKey: true });
	expect(taken).toBe(true);
	expect(store.getState().zooms["a.ts"]).toBe(110);
	// A plain wheel scrolls the diff as before.
	expect(fireEvent.wheel(host as Element, { deltaY: -120 })).toBe(true);
	expect(store.getState().zooms["a.ts"]).toBe(110);
});

test("outside a workspace the diff keeps its own zoom", async () => {
	render(<DiffViewer path="a.ts" original="1" modified="2" version="v" />);
	await vi.waitFor(() => expect(fake.options).toHaveLength(1));
	fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
	expect(zoomText()).toBe("110%");
});
