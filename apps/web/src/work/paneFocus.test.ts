import type { ProjectLayout } from "@portikus/contracts";
import { afterEach, expect, test } from "vitest";
import { focusAfterPane, neighbourPane, tabAfterClose } from "./paneFocus.js";

const layout: ProjectLayout = {
	tabs: [
		{
			id: "t1",
			root: {
				type: "split",
				direction: "row",
				sizes: [34, 33, 33],
				children: [
					{ type: "leaf", terminalId: "a" },
					{ type: "leaf", terminalId: "b" },
					{ type: "leaf", terminalId: "c" },
				],
			},
		},
		{ id: "t2", root: { type: "leaf", terminalId: "d" } },
		{ id: "t3", root: { type: "leaf", terminalId: "e" } },
	],
};

afterEach(() => document.body.replaceChildren());

test("the next pane in the tab takes over, else the one before, else none", () => {
	expect(neighbourPane(layout, "a")).toBe("b");
	expect(neighbourPane(layout, "c")).toBe("b");
	expect(neighbourPane(layout, "d")).toBeNull();
	expect(neighbourPane(layout, "missing")).toBeNull();
});

test("the keyboard goes into the neighbour's terminal input, or to the fallback", () => {
	document.body.innerHTML = `
		<div data-testid="terminal-pane-b"><textarea class="xterm-helper-textarea"></textarea></div>
		<button id="fallback">New</button>`;
	const fallback = document.getElementById("fallback");
	expect(focusAfterPane(layout, "a", fallback)).toBe("b");
	expect(document.activeElement?.tagName).toBe("TEXTAREA");

	expect(focusAfterPane(layout, "d", fallback)).toBeNull();
	expect(document.activeElement).toBe(fallback);
});

const mixed: ProjectLayout = {
	tabs: [
		{
			id: "t1",
			root: {
				type: "split",
				direction: "row",
				sizes: [50, 50],
				children: [
					{ type: "leaf", terminalId: "a" },
					{ type: "file", path: "src/app.ts" },
				],
			},
		},
	],
};

test("a file pane and a terminal pane take over from each other", () => {
	expect(neighbourPane(mixed, "file:src/app.ts")).toBe("a");
	expect(neighbourPane(mixed, "a")).toBe("file:src/app.ts");
});

test("closing a file hands the keyboard to the terminal beside it", () => {
	document.body.innerHTML = `
		<div data-testid="terminal-pane-a"><textarea class="xterm-helper-textarea"></textarea></div>
		<button id="fallback">New</button>`;
	const fallback = document.getElementById("fallback");
	expect(focusAfterPane(mixed, "file:src/app.ts", fallback)).toBe("a");
	expect(document.activeElement?.tagName).toBe("TEXTAREA");
});

test("closing a terminal hands the keyboard to the file beside it: its editor, else its actions", () => {
	document.body.innerHTML = `
		<section data-testid="file-frame-src/app.ts">
			<button data-testid="file-frame-actions-src/app.ts">Actions</button>
			<div class="monaco-editor"><textarea class="inputarea"></textarea></div>
		</section>
		<button id="fallback">New</button>`;
	const fallback = document.getElementById("fallback");
	expect(focusAfterPane(mixed, "a", fallback)).toBe("file:src/app.ts");
	expect(document.activeElement?.className).toBe("inputarea");

	document.body.innerHTML = `
		<section data-testid="file-frame-src/app.ts">
			<button data-testid="file-frame-actions-src/app.ts">Actions</button>
		</section>`;
	expect(focusAfterPane(mixed, "a", null)).toBe("file:src/app.ts");
	expect(document.activeElement?.getAttribute("data-testid")).toBe(
		"file-frame-actions-src/app.ts",
	);
});

test("a closed tab hands over to the last one active, else its left, then right neighbour", () => {
	expect(tabAfterClose(layout, "t2", ["t2", "t3", "t1"])).toBe("t3");
	expect(tabAfterClose(layout, "t2", [])).toBe("t1");
	expect(tabAfterClose(layout, "t1", [])).toBe("t2");
	expect(
		tabAfterClose(
			{ tabs: [layout.tabs[0] as ProjectLayout["tabs"][number]] },
			"t1",
			[],
		),
	).toBeNull();
});
