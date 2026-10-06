import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { json, renderWithQuery, stubFetch } from "../../test-utils.js";
import { RootShellArea } from "./RootShellArea.js";
import type { RootShellLeafProps } from "./RootShellLeaf.js";
import type { RootShellSessionProps } from "./RootShellSession.js";

// The terminal and socket are covered by RootShellSession.test.tsx and the
// browser tests; here stand-ins expose the pane's actions as buttons and
// count how often each session mounts.
const sessionMounts = new Map<string, number>();
vi.mock("./RootShellSession.js", () => ({
	createSessionHost: () => document.createElement("div"),
	RootShellSession: (props: RootShellSessionProps) => {
		useEffect(() => {
			sessionMounts.set(props.shellId, (sessionMounts.get(props.shellId) ?? 0) + 1);
		}, [props.shellId]);
		return (
			<button type="button" onClick={() => props.onExited(props.shellId)}>
				Exit {props.name}
			</button>
		);
	},
}));
vi.mock("./RootShellLeaf.js", () => ({
	RootShellLeaf: (props: RootShellLeafProps) => (
		<section aria-label={props.name} data-testid="leaf">
			<button type="button" onClick={() => props.onSplit(props.shellId, "row")}>
				Split right
			</button>
			<button type="button" onClick={() => props.onMoveToNewTab(props.shellId)}>
				Move to new tab
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
	sessionMounts.clear();
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
	fireEvent.click(screen.getByRole("button", { name: "Exit Root shell 2" }));
	expect(screen.getAllByTestId("leaf")).toHaveLength(1);

	fireEvent.click(screen.getByRole("button", { name: "Exit Root shell 1" }));
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

test("a pane moved to a new tab keeps its name and its shell there", () => {
	renderWithQuery(<RootShellArea visible={true} />);
	fireEvent.click(screen.getByRole("button", { name: "Open a root shell" }));
	fireEvent.click(screen.getByRole("button", { name: "Split right" }));
	const second = screen.getByRole("region", { name: "Root shell 2" });
	fireEvent.click(within(second).getByRole("button", { name: "Move to new tab" }));
	expect(tabNames()).toEqual(["Root shell 1", "Root shell 2"]);
	// The same session: a remount would hang up the shell and open another.
	expect([...sessionMounts.values()]).toEqual([1, 1]);
});
