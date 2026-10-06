import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { RootShellLeaf } from "./RootShellLeaf.js";

afterEach(cleanup);

function leaf(host: HTMLDivElement, ended = false) {
	return (
		<RootShellLeaf
			shellId="s1"
			name="Root shell 1"
			theme="dark"
			host={host}
			ended={ended}
			focused={false}
			alone={false}
			dropEdge={null}
			moveTargets={[]}
			onFocus={vi.fn()}
			onSplit={vi.fn()}
			onMoveToNewTab={vi.fn()}
			onMoveInto={vi.fn()}
			onResetSizes={vi.fn()}
			onLeave={vi.fn()}
			onClose={vi.fn()}
		/>
	);
}

test("the pane adopts its session's element, and a pane mounted later takes it over", () => {
	const host = document.createElement("div");
	const first = render(leaf(host));
	const pane = screen.getByRole("region", { name: "Terminal: Root shell 1" });
	expect(pane.contains(host)).toBe(true);

	// A move to another tab mounts a new pane; the same element moves into it.
	const second = render(leaf(host));
	first.unmount();
	expect(second.container.contains(host)).toBe(true);
});
