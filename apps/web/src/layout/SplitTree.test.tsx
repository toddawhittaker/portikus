import type { SplitNode } from "@portikus/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { SplitTree } from "./SplitTree";

afterEach(cleanup);

// A row of one terminal and a column of a file over a preview.
const root: SplitNode = {
	type: "split",
	direction: "row",
	sizes: [70, 30],
	children: [
		{ type: "leaf", terminalId: "t1" },
		{
			type: "split",
			direction: "column",
			sizes: [80, 20],
			children: [
				{ type: "file", path: "src/a.ts" },
				{ type: "preview", port: 3000 },
			],
		},
	],
};

function renderTree(onResize = vi.fn()) {
	render(
		<SplitTree
			tabId="tab-1"
			root={root}
			onResize={onResize}
			renderLeaf={(node, { resetSizes }) => (
				<button type="button" data-testid={`leaf-${node.type}`} onClick={resetSizes}>
					{node.type}
				</button>
			)}
		/>,
	);
	return onResize;
}

test("every leaf goes to renderLeaf, nested in a split for each direction", () => {
	renderTree();
	expect(screen.getByTestId("leaf-leaf")).toBeTruthy();
	expect(screen.getByTestId("leaf-file")).toBeTruthy();
	expect(screen.getByTestId("leaf-preview")).toBeTruthy();
	const directions = [...document.querySelectorAll("[data-direction]")].map((node) =>
		node.getAttribute("data-direction"),
	);
	expect(directions).toEqual(["row", "column"]);
	// One handle between the two children of each split.
	expect(screen.getAllByRole("separator")).toHaveLength(2);
});

test("a lone leaf renders with no split around it", () => {
	render(
		<SplitTree
			tabId="tab-1"
			root={{ type: "leaf", terminalId: "t1" }}
			onResize={vi.fn()}
			renderLeaf={() => <p data-testid="only" />}
		/>,
	);
	expect(screen.getByTestId("only")).toBeTruthy();
	expect(document.querySelector("[data-direction]")).toBeNull();
});

test("resetting sizes saves even sizes for every split, by its path", () => {
	const onResize = renderTree();
	fireEvent.click(screen.getByTestId("leaf-preview"));
	expect(onResize).toHaveBeenCalledWith([], [50, 50]);
	expect(onResize).toHaveBeenCalledWith([1], [50, 50]);
	expect(onResize).toHaveBeenCalledTimes(2);
});
