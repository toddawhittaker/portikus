import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
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
			<div data-testid={`terminal-pane-${props.shellId}`}>
				<textarea
					className="xterm-helper-textarea"
					aria-label={`Input of ${props.name}`}
				/>
				<button type="button" onClick={() => props.onExited(props.shellId)}>
					Exit {props.name}
				</button>
				<button
					type="button"
					onClick={() => props.onLossChange(props.shellId, "server_stopped")}
				>
					Lose {props.name}
				</button>
			</div>
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
	renderWithQuery(<RootShellArea visible={true} onLoss={vi.fn()} />);
	expect(screen.getByRole("heading", { level: 2, name: "Root shell" })).toBeDefined();
	expect(screen.getByTestId("root-shell-banner").textContent).toContain(
		"root shells on this server",
	);
	expect(screen.getByText("No root shells open")).toBeDefined();
	expect(screen.queryAllByTestId("leaf")).toHaveLength(0);
});

test("links its help topic", () => {
	renderWithQuery(<RootShellArea visible={true} onLoss={vi.fn()} />);
	const link = screen.getByRole("link", { name: /More in Help/ });
	expect(link.getAttribute("href")).toBe("/admin/help#admin-shell");
});

test("each new shell gets a numbered tab; a split adds a pane to the same tab", () => {
	renderWithQuery(<RootShellArea visible={true} onLoss={vi.fn()} />);
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
	renderWithQuery(<RootShellArea visible={true} onLoss={vi.fn()} />);
	fireEvent.click(screen.getByRole("button", { name: "Open a root shell" }));
	fireEvent.click(screen.getByRole("button", { name: "Split right" }));
	fireEvent.click(screen.getByRole("button", { name: "Exit Root shell 2" }));
	expect(screen.getAllByTestId("leaf")).toHaveLength(1);

	fireEvent.click(screen.getByRole("button", { name: "Exit Root shell 1" }));
	expect(screen.queryAllByRole("tab")).toHaveLength(0);
	expect(screen.getByText("No root shells open")).toBeDefined();
});

test("closing a tab of several shells asks first", () => {
	renderWithQuery(<RootShellArea visible={true} onLoss={vi.fn()} />);
	fireEvent.click(screen.getByRole("button", { name: "Open a root shell" }));
	fireEvent.click(screen.getByRole("button", { name: "Split right" }));
	fireEvent.click(screen.getByTestId(/^tab-.*-close$/));
	const dialog = screen.getByRole("alertdialog", { name: "Close this tab?" });
	expect(dialog.textContent).toContain("It has 2 root shells");
	fireEvent.click(within(dialog).getByRole("button", { name: "Close tab" }));
	expect(screen.queryAllByTestId("leaf")).toHaveLength(0);
});

test("a pane moved to a new tab keeps its name and its shell there", () => {
	renderWithQuery(<RootShellArea visible={true} onLoss={vi.fn()} />);
	fireEvent.click(screen.getByRole("button", { name: "Open a root shell" }));
	fireEvent.click(screen.getByRole("button", { name: "Split right" }));
	const second = screen.getByRole("region", { name: "Root shell 2" });
	fireEvent.click(within(second).getByRole("button", { name: "Move to new tab" }));
	expect(tabNames()).toEqual(["Root shell 1", "Root shell 2"]);
	// The same session: a remount would hang up the shell and open another.
	expect([...sessionMounts.values()]).toEqual([1, 1]);
});

test("Close in a pane's menu moves the keyboard to the next pane, then to New root shell", () => {
	renderWithQuery(<RootShellArea visible={true} onLoss={vi.fn()} />);
	fireEvent.click(screen.getByRole("button", { name: "Open a root shell" }));
	fireEvent.click(screen.getByRole("button", { name: "Split right" }));
	const first = screen.getByRole("region", { name: "Root shell 1" });
	fireEvent.click(within(first).getByRole("button", { name: "Close" }));
	expect(document.activeElement).toBe(screen.getByLabelText("Input of Root shell 2"));

	fireEvent.click(screen.getByRole("button", { name: "Close" }));
	expect(document.activeElement).toBe(screen.getByTestId("root-shell-new"));
});

test("an exit while typing moves the keyboard to New root shell, as in a workspace", () => {
	renderWithQuery(<RootShellArea visible={true} onLoss={vi.fn()} />);
	fireEvent.click(screen.getByRole("button", { name: "Open a root shell" }));
	fireEvent.click(screen.getByRole("button", { name: "Split right" }));
	screen.getByLabelText("Input of Root shell 2").focus();
	fireEvent.click(screen.getByRole("button", { name: "Exit Root shell 2" }));
	expect(document.activeElement).toBe(screen.getByTestId("root-shell-new"));
});

test("every lost shell, in any tab, is reported to the caller", () => {
	const onLoss = vi.fn();
	renderWithQuery(<RootShellArea visible={true} onLoss={onLoss} />);
	fireEvent.click(screen.getByRole("button", { name: "Open a root shell" }));
	fireEvent.click(screen.getByTestId("root-shell-new"));
	fireEvent.click(screen.getByTestId("root-shell-new"));
	// Two of the three are in hidden tabs.
	fireEvent.click(screen.getByRole("button", { name: "Lose Root shell 1" }));
	fireEvent.click(screen.getByRole("button", { name: "Lose Root shell 2" }));
	fireEvent.click(screen.getByRole("button", { name: "Lose Root shell 3" }));
	expect(onLoss.mock.calls).toEqual([
		["server_stopped"],
		["server_stopped"],
		["server_stopped"],
	]);
});

test("confirming a tab close returns the keyboard to the tab now shown", async () => {
	renderWithQuery(<RootShellArea visible={true} onLoss={vi.fn()} />);
	fireEvent.click(screen.getByRole("button", { name: "Open a root shell" }));
	fireEvent.click(screen.getByRole("button", { name: "Split right" }));
	fireEvent.click(screen.getByTestId("root-shell-new"));
	fireEvent.click(screen.getAllByTestId(/^tab-.*-close$/)[0] as HTMLElement);
	const dialog = screen.getByRole("alertdialog", { name: "Close this tab?" });
	fireEvent.click(within(dialog).getByRole("button", { name: "Close tab" }));
	const remaining = screen.getByRole("tab", { name: /Root shell 3/ });
	await waitFor(() => expect(document.activeElement).toBe(remaining));
	expect(remaining.getAttribute("aria-selected")).toBe("true");
});
