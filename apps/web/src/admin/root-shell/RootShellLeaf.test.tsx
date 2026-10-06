import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { RootShellLeaf } from "./RootShellLeaf.js";

afterEach(cleanup);

function leaf(host: HTMLDivElement, focused = false) {
	return (
		<RootShellLeaf
			shellId="s1"
			name="Root shell 1"
			theme="dark"
			host={host}
			ended={false}
			focused={focused}
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

/** A session element holding a terminal input, as xterm.js makes one. */
function hostWithInput(): { host: HTMLDivElement; input: HTMLTextAreaElement } {
	const host = document.createElement("div");
	const input = document.createElement("textarea");
	input.className = "xterm-helper-textarea";
	host.append(input);
	return { host, input };
}

test("the focused pane takes the keyboard back when moving its element dropped it", () => {
	const { host, input } = hostWithInput();
	render(leaf(host, true));
	expect(document.activeElement).toBe(input);
});

test("a pane that is not the focused one leaves the keyboard alone", () => {
	const { host, input } = hostWithInput();
	render(leaf(host, false));
	expect(document.activeElement).not.toBe(input);
});
