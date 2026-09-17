import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { WORKSPACE } from "./test-utils.js";
import { startingPhase, WorkspaceStarting } from "./WorkspaceStarting.js";

test("no workspace yet means connecting", () => {
	expect(startingPhase(null)).toBe("connecting");
	render(<WorkspaceStarting workspace={null} />);
	expect(screen.getByRole("heading").textContent).toBe("Connecting to your workspace");
});

test("a stopped workspace that should run is starting", () => {
	const workspace = { ...WORKSPACE, state: "stopped" as const };
	expect(startingPhase(workspace)).toBe("starting");
	render(<WorkspaceStarting workspace={workspace} />);
	expect(screen.getByRole("heading").textContent).toBe("Starting your workspace");
});

test("a running workspace is reopening tabs", () => {
	expect(startingPhase(WORKSPACE)).toBe("restoring");
});

test("stopping and error have their own copy, and the error shows the detail", () => {
	expect(startingPhase({ ...WORKSPACE, state: "stopping" })).toBe("stopping");
	const failed = {
		...WORKSPACE,
		state: "error" as const,
		errorCode: "STORAGE_FULL",
		errorMessage: "Your workspace could not start because its storage is full.",
	};
	expect(startingPhase(failed)).toBe("error");

	render(<WorkspaceStarting workspace={failed} />);
	expect(screen.getByRole("heading").textContent).toBe(
		"Your workspace could not be started",
	);
	expect(
		screen.getByText("Your workspace could not start because its storage is full."),
	).toBeDefined();
	expect(screen.getByText("STORAGE_FULL")).toBeDefined();
});
