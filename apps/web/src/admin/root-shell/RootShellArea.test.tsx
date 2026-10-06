import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { json, renderWithQuery, stubFetch } from "../../test-utils.js";
import { RootShellArea } from "./RootShellArea.js";
import type { RootShellLeafProps } from "./RootShellLeaf.js";

// The leaf's terminal and socket are covered by rootShellSocket.test.ts and
// the browser tests; here a stand-in exposes the pane's actions as buttons.
vi.mock("./RootShellLeaf.js", () => ({
	RootShellLeaf: (props: RootShellLeafProps) => (
		<section aria-label={props.name} data-testid="leaf">
			<button type="button" onClick={() => props.onSplit(props.shellId, "row")}>
				Split right
			</button>
			<button type="button" onClick={() => props.onMoveToNewTab(props.shellId)}>
				Move to new tab
			</button>
			<button type="button" onClick={() => props.onExited(props.shellId)}>
				Exit
			</button>
			<button type="button" onClick={() => props.onClose(props.shellId)}>
				Close
			</button>
		</section>
	),
}));

beforeEach(() => {
	stubFetch((url) => {
		if (url === "/me/settings") return json(404, {});
		throw new Error(`unexpected request: ${url}`);
	});
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

function tabNames(): string[] {
	return screen.getAllByRole("tab").map((tab) => tab.textContent ?? "");
}

test("nothing opens until asked, and the banner says what these shells are", () => {
	renderWithQuery(<RootShellArea visible={true} />);
	expect(screen.getByRole("heading", { level: 2, name: "Root shell" })).toBeDefined();
	expect(screen.getByTestId("root-shell-banner").textContent).toContain(
		"root shells on this server",
	);
	expect(screen.getByText("No root shells open")).toBeDefined();
	expect(screen.queryAllByTestId("leaf")).toHaveLength(0);
});

test("each new shell gets a numbered tab; a split adds a pane to the same tab", () => {
	renderWithQuery(<RootShellArea visible={true} />);
	fireEvent.click(screen.getByRole("button", { name: "Open a root shell" }));
	expect(tabNames()).toEqual(["Root shell 1"]);

	fireEvent.click(screen.getByRole("button", { name: "Split right" }));
	expect(tabNames()).toEqual(["Root shell 1"]);
	expect(
		screen.getAllByTestId("leaf").map((leaf) => leaf.getAttribute("aria-label")),
	).toEqual(["Root shell 1", "Root shell 2"]);

	fireEvent.click(screen.getByTestId("root-shell-new"));
	expect(tabNames()).toEqual(["Root shell 1", "Root shell 3"]);
});

test("a shell that exits takes its pane away, and its tab with the last one", () => {
	renderWithQuery(<RootShellArea visible={true} />);
	fireEvent.click(screen.getByRole("button", { name: "Open a root shell" }));
	fireEvent.click(screen.getByRole("button", { name: "Split right" }));
	const second = screen.getByRole("region", { name: "Root shell 2" });
	fireEvent.click(within(second).getByRole("button", { name: "Exit" }));
	expect(screen.getAllByTestId("leaf")).toHaveLength(1);

	fireEvent.click(screen.getByRole("button", { name: "Exit" }));
	expect(screen.queryAllByRole("tab")).toHaveLength(0);
	expect(screen.getByText("No root shells open")).toBeDefined();
});

test("closing a tab of several shells asks first", () => {
	renderWithQuery(<RootShellArea visible={true} />);
	fireEvent.click(screen.getByRole("button", { name: "Open a root shell" }));
	fireEvent.click(screen.getByRole("button", { name: "Split right" }));
	fireEvent.click(screen.getByTestId(/^tab-.*-close$/));
	const dialog = screen.getByRole("alertdialog", { name: "Close this tab?" });
	expect(dialog.textContent).toContain("It has 2 root shells");
	fireEvent.click(within(dialog).getByRole("button", { name: "Close tab" }));
	expect(screen.queryAllByTestId("leaf")).toHaveLength(0);
});

test("a pane moved to a new tab keeps its name there", () => {
	renderWithQuery(<RootShellArea visible={true} />);
	fireEvent.click(screen.getByRole("button", { name: "Open a root shell" }));
	fireEvent.click(screen.getByRole("button", { name: "Split right" }));
	const second = screen.getByRole("region", { name: "Root shell 2" });
	fireEvent.click(within(second).getByRole("button", { name: "Move to new tab" }));
	expect(tabNames()).toEqual(["Root shell 1", "Root shell 2"]);
});
