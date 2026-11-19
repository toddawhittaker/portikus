/**
 * The pick button (SPEC.md §14.6, §25.8): the agent is chosen before
 * picking, the button says why when it cannot be used, and it is not
 * offered in a Traditional course.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
	type AgentDropTarget,
	getAgentDropTargets,
	registerAgentDropTarget,
} from "../../agents/agentDropTargets.js";
import { inTabOrder, menuLabels, NO_AGENT_TEXT, PickControl } from "./PickControl.js";
import type { PickMode } from "./usePickMode.js";

let profile: "agentic" | "traditional" = "agentic";
vi.mock("../../editor/settingsQueries.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../editor/settingsQueries.js")>()),
	useCourseProfile: () => profile,
}));

const offs: Array<() => void> = [];

function addTarget(id: string, label = `Agent ${id}`): AgentDropTarget {
	const target: AgentDropTarget = {
		terminalId: id,
		label,
		deliver: async () => true,
	};
	act(() => {
		offs.push(registerAgentDropTarget(target));
	});
	return target;
}

function mode(state: PickMode["state"] = "idle"): PickMode {
	return {
		state,
		hoverLabel: "",
		start: vi.fn(),
		stop: vi.fn(),
	};
}

beforeEach(() => {
	profile = "agentic";
});

afterEach(() => {
	cleanup();
	for (const off of offs.splice(0)) off();
});

function button() {
	return screen.getByRole("button", { name: "Pick an element" });
}

test("with no agent open it is unavailable, reachable by Tab, and says why", async () => {
	const pick = mode();
	render(<PickControl pick={pick} ready={true} />);
	expect((button() as HTMLButtonElement).disabled).toBe(false);
	expect(button().getAttribute("aria-disabled")).toBe("true");
	expect(button().hasAttribute("title")).toBe(false);
	const describedBy = button().getAttribute("aria-describedby") ?? "";
	expect(document.getElementById(describedBy)?.textContent).toBe(NO_AGENT_TEXT);
	fireEvent.click(button());
	expect(pick.start).not.toHaveBeenCalled();
	// Focus shows the reason in the tooltip, not only a hover.
	act(() => button().focus());
	expect(
		(await screen.findAllByText(`Pick an element: ${NO_AGENT_TEXT}`)).length,
	).toBeGreaterThan(0);
});

test("with no page on show it is unavailable, even with several agents", () => {
	addTarget("t1");
	addTarget("t2");
	const pick = mode();
	render(<PickControl pick={pick} ready={false} />);
	expect(button().getAttribute("aria-disabled")).toBe("true");
	fireEvent.pointerDown(button(), { button: 0, pointerType: "mouse" });
	fireEvent.click(button());
	expect(screen.queryByRole("menu")).toBeNull();
	expect(pick.start).not.toHaveBeenCalled();
});

test("with one agent open a press starts picking for it at once", () => {
	const target = addTarget("t1");
	const pick = mode();
	render(<PickControl pick={pick} ready={true} />);
	expect(button().getAttribute("aria-pressed")).toBe("false");
	fireEvent.click(button());
	expect(pick.start).toHaveBeenCalledWith(target);
});

test("with several agents open it asks which, then starts for that one", async () => {
	addTarget("t1");
	const second = addTarget("t2");
	const pick = mode();
	render(<PickControl pick={pick} ready={true} />);
	fireEvent.pointerDown(button(), { button: 0, pointerType: "mouse" });
	const item = await screen.findByRole("menuitem", { name: "Agent t2" });
	expect(screen.getByRole("menuitem", { name: "Agent t1" })).toBeTruthy();
	expect(pick.start).not.toHaveBeenCalled();
	fireEvent.click(item);
	await vi.waitFor(() => expect(pick.start).toHaveBeenCalledWith(second));
});

test("two agents of one kind are told apart by number in the menu", async () => {
	addTarget("t1", "Claude Code (TUI)");
	addTarget("t2", "Codex (TUI)");
	const second = addTarget("t3", "Claude Code (TUI)");
	const pick = mode();
	render(<PickControl pick={pick} ready={true} />);
	fireEvent.pointerDown(button(), { button: 0, pointerType: "mouse" });
	const item = await screen.findByRole("menuitem", { name: "Claude Code (TUI) 2" });
	expect(screen.getAllByRole("menuitem").map((option) => option.textContent)).toEqual([
		"Claude Code (TUI) 1",
		"Codex (TUI)",
		"Claude Code (TUI) 2",
	]);
	fireEvent.click(item);
	await vi.waitFor(() => expect(pick.start).toHaveBeenCalledWith(second));
});

test("chats are told apart by their titles, and the list follows tab order", async () => {
	// The panes as the work area draws them: t2's tab comes first.
	for (const id of ["t2", "t1", "t3"]) {
		const pane = document.createElement("div");
		pane.dataset.testid = `terminal-leaf-${id}`;
		document.body.append(pane);
	}
	addTarget("t1", "Claude Code (GUI)");
	addTarget("t2", "Claude Code (GUI)");
	addTarget("t3", "Codex (TUI)");
	const titles = new Map([
		["t1", "Fix the header"],
		["t2", "Add a footer"],
	]);
	expect(menuLabels(inTabOrder(getAgentDropTargets()), titles)).toEqual([
		"Claude Code (GUI): Add a footer",
		"Claude Code (GUI): Fix the header",
		"Codex (TUI)",
	]);
	for (const id of ["t1", "t2", "t3"])
		document.querySelector(`[data-testid="terminal-leaf-${id}"]`)?.remove();
});

test("a pick started from the menu keeps the keyboard where the pick put it", async () => {
	addTarget("t1");
	addTarget("t2");
	const elsewhere = document.createElement("button");
	document.body.append(elsewhere);
	const pick = mode();
	vi.mocked(pick.start).mockImplementation(() => elsewhere.focus());
	render(<PickControl pick={pick} ready={true} />);
	fireEvent.keyDown(button(), { key: "Enter" });
	const item = await screen.findByRole("menuitem", { name: "Agent t2" });
	fireEvent.click(item);
	await vi.waitFor(() => expect(pick.start).toHaveBeenCalledOnce());
	expect(document.activeElement).toBe(elsewhere);
	elsewhere.remove();
});

test("two agents of one kind are told apart by number in the menu", async () => {
	addTarget("t1", "Claude Code (TUI)");
	addTarget("t2", "Codex (TUI)");
	const second = addTarget("t3", "Claude Code (TUI)");
	const pick = mode();
	render(<PickControl pick={pick} ready={true} />);
	fireEvent.pointerDown(button(), { button: 0, pointerType: "mouse" });
	const item = await screen.findByRole("menuitem", { name: "Claude Code (TUI) 2" });
	expect(screen.getAllByRole("menuitem").map((option) => option.textContent)).toEqual([
		"Claude Code (TUI) 1",
		"Codex (TUI)",
		"Claude Code (TUI) 2",
	]);
	fireEvent.click(item);
	expect(pick.start).toHaveBeenCalledWith(second);
});

test("while picking it reads as pressed and a press stops", () => {
	addTarget("t1");
	const pick = mode("picking");
	render(<PickControl pick={pick} ready={true} />);
	expect(button().getAttribute("aria-pressed")).toBe("true");
	fireEvent.click(button());
	expect(pick.stop).toHaveBeenCalled();
	expect(pick.start).not.toHaveBeenCalled();
});

test("while picking with several agents a press stops instead of asking", () => {
	addTarget("t1");
	addTarget("t2");
	const pick = mode("picking");
	render(<PickControl pick={pick} ready={true} />);
	fireEvent.pointerDown(button(), { button: 0, pointerType: "mouse" });
	expect(pick.stop).toHaveBeenCalled();
	expect(screen.queryByRole("menu")).toBeNull();
});

test("it is not offered in a Traditional course", () => {
	profile = "traditional";
	addTarget("t1");
	render(<PickControl pick={mode()} ready={true} />);
	expect(screen.queryByRole("button", { name: "Pick an element" })).toBeNull();
});
