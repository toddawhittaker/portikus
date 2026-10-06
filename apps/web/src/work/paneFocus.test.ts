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
