/**
 * Preview tabs in a saved layout (SPEC.md §7.5, §14.6). A preview is a tab
 * of its own, one per port, and it survives a reload like a file tab.
 */
import { MAX_LAYOUT_TABS, ProjectLayout } from "@portikus/contracts";
import { expect, test } from "vitest";
import { createLayoutStore } from "./store.js";
import { emptyLayout, openPreview, previewTabId } from "./tree.js";

test("opening a port adds one preview tab", () => {
	const opened = openPreview(emptyLayout(), 5173);
	expect(opened?.tabId).toBe("preview:5173");
	expect(opened?.layout.tabs).toEqual([
		{ id: "preview:5173", root: { type: "preview", port: 5173 } },
	]);
});

test("opening the same port twice keeps one tab", () => {
	const first = openPreview(emptyLayout(), 5173);
	if (!first) throw new Error("expected a tab");
	const second = openPreview(first.layout, 5173);
	expect(second?.layout).toBe(first.layout);
	expect(second?.tabId).toBe(first.tabId);
});

test("a full tab strip refuses another preview", () => {
	let layout = emptyLayout();
	for (let i = 0; i < MAX_LAYOUT_TABS; i += 1) {
		layout = {
			tabs: [
				...layout.tabs,
				{ id: `t${i}`, root: { type: "leaf", terminalId: `t${i}` } },
			],
		};
	}
	expect(openPreview(layout, 5173)).toBeNull();
});

test("a preview tab is a layout the API accepts", () => {
	const opened = openPreview(emptyLayout(), 5173);
	expect(ProjectLayout.safeParse(opened?.layout).success).toBe(true);
});

test("a preview may not be split with a terminal", () => {
	const parsed = ProjectLayout.safeParse({
		tabs: [
			{
				id: "mixed",
				root: {
					type: "split",
					direction: "row",
					sizes: [50, 50],
					children: [
						{ type: "leaf", terminalId: "44444444-4444-4444-8444-444444444444" },
						{ type: "preview", port: 5173 },
					],
				},
			},
		],
	});
	expect(parsed.success).toBe(false);
});

test("a preview tab id must name its port", () => {
	const parsed = ProjectLayout.safeParse({
		tabs: [{ id: "preview:80", root: { type: "preview", port: 5173 } }],
	});
	expect(parsed.success).toBe(false);
});

test("the store opens, activates and closes a preview tab", () => {
	const store = createLayoutStore();
	expect(store.getState().openPreview(5173)).toBe(true);
	expect(store.getState().activeTabId).toBe(previewTabId(5173));
	expect(store.getState().dirty).toBe(true);
	store.getState().closeTab(previewTabId(5173));
	expect(store.getState().layout.tabs).toEqual([]);
});
