import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
	type DesiredState,
	resolveWorkspaceState,
	StateBadge,
	type WorkspaceState,
} from "./StateBadge.js";

// The table in design/system/components/StateBadge/README.md.
const CASES: [WorkspaceState, DesiredState | undefined, string, string, boolean][] = [
	["running", "running", "Running", "running", false],
	["stopped", "stopped", "Stopped", "stopped", false],
	["error", "running", "Error", "error", false],
	["error", undefined, "Error", "error", false],
	["provisioning", "running", "Setting up", "provisioning", true],
	["starting", "running", "Starting", "starting", true],
	["stopped", "running", "Starting", "starting", true],
	["running", "stopped", "Stopping", "stopping", true],
	["stopping", "stopped", "Stopping", "stopping", true],
	["running", "restarting", "Restarting", "starting", true],
	["stopped", "restarting", "Restarting", "starting", true],
	["stopping", "restarting", "Restarting", "stopping", true],
];

describe("resolveWorkspaceState", () => {
	it.each(CASES)("%s wanting %s is %s", (state, desired, label, tone, moving) => {
		expect(resolveWorkspaceState(state, desired)).toEqual({ tone, label, moving });
	});
});

describe("StateBadge", () => {
	it.each(CASES)("shows %s wanting %s as %s", (state, desired, label) => {
		const { unmount } = render(<StateBadge state={state} desiredState={desired} />);
		expect(screen.getByRole("status").textContent).toBe(label);
		unmount();
	});

	it("announces politely when live", () => {
		render(<StateBadge state="running" live={true} />);
		expect(screen.getByRole("status").getAttribute("aria-live")).toBe("polite");
	});
});
