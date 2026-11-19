/**
 * The pick button (SPEC.md §14.6, §25.8): the agent is chosen before
 * picking, the button says why when it cannot be used, and it is not
 * offered in a Traditional course.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
	type AgentDropTarget,
	registerAgentDropTarget,
} from "../../agents/agentDropTargets.js";
import { NO_AGENT_TEXT, PickControl } from "./PickControl.js";
import type { PickMode } from "./usePickMode.js";

let profile: "agentic" | "traditional" = "agentic";
vi.mock("../../editor/settingsQueries.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../editor/settingsQueries.js")>()),
	useCourseProfile: () => profile,
}));

const offs: Array<() => void> = [];

function addTarget(id: string): AgentDropTarget {
	const target: AgentDropTarget = {
		terminalId: id,
		kind: "terminal",
		label: `Agent ${id}`,
		deliver: async () => {},
	};
	act(() => {
		offs.push(registerAgentDropTarget(target));
	});
	return target;
}

function mode(state: PickMode["state"] = "idle"): PickMode {
	return {
		state,
		targetId: null,
		hoverLabel: "",
		start: vi.fn(),
		stop: vi.fn(),
		frameLoaded: vi.fn(),
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

test("with no agent open it is disabled and says why", () => {
	render(<PickControl pick={mode()} ready={true} />);
	expect((button() as HTMLButtonElement).disabled).toBe(true);
	const describedBy = button().getAttribute("aria-describedby") ?? "";
	expect(document.getElementById(describedBy)?.textContent).toBe(NO_AGENT_TEXT);
});

test("with no page on show it is disabled", () => {
	addTarget("t1");
	render(<PickControl pick={mode()} ready={false} />);
	expect((button() as HTMLButtonElement).disabled).toBe(true);
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
