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

	it("has no status role in a table cell", () => {
		render(<StateBadge state="running" statusRole={false} />);
		expect(screen.queryByRole("status")).toBeNull();
		expect(screen.getByText("Running")).toBeTruthy();
	});
});

describe("StateBadge moving", () => {
	it.each<WorkspaceState>(["stopped", "running", "error"])(
		"shows a spinner on a %s workspace, in a transition's tone",
		(state) => {
			const { container, unmount } = render(
				<StateBadge state={state} moving={true} label="Rebuilding…" />,
			);
			const badge = screen.getByRole("status");
			expect(badge.textContent).toBe("Rebuilding…");
			expect(container.querySelector(".pk-spin")).not.toBeNull();
			expect(container.querySelector(".pk-badge-ring")).toBeNull();
			expect(container.querySelector(".pk-badge-dot")).toBeNull();
			expect(badge.className).toContain("text-status-starting");
			// The real state stays on the element.
			expect(badge.getAttribute("data-state")).toBe(state);
			unmount();
		},
	);

	it("keeps a transition's own tone", () => {
		render(<StateBadge state="stopping" moving={true} label="Rebuilding…" />);
		expect(screen.getByRole("status").className).toContain("text-status-stopping");
	});

	it("without it, a stopped workspace keeps its ring", () => {
		const { container } = render(<StateBadge state="stopped" label="Rebuilding…" />);
		expect(container.querySelector(".pk-badge-ring")).not.toBeNull();
		expect(container.querySelector(".pk-spin")).toBeNull();
	});
});
