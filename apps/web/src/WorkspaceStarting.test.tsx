import { screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { renderWithQuery, WORKSPACE } from "./test-utils.js";
import { startingPhase, WorkspaceStarting } from "./WorkspaceStarting.js";

test("no workspace yet means connecting", () => {
	expect(startingPhase(null)).toBe("connecting");
	renderWithQuery(<WorkspaceStarting workspaceId={WORKSPACE.id} workspace={null} />);
	expect(screen.getByRole("heading").textContent).toBe("Connecting to your workspace");
});

test("a stopped workspace that should run is starting", () => {
	const workspace = { ...WORKSPACE, state: "stopped" as const };
	expect(startingPhase(workspace)).toBe("starting");
	renderWithQuery(
		<WorkspaceStarting workspaceId={WORKSPACE.id} workspace={workspace} />,
	);
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

	renderWithQuery(<WorkspaceStarting workspaceId={WORKSPACE.id} workspace={failed} />);
	expect(screen.getByRole("heading").textContent).toBe(
		"Your workspace could not be started",
	);
	expect(
		screen.getByText("Your workspace could not start because its storage is full."),
	).toBeDefined();
	expect(screen.getByText("STORAGE_FULL")).toBeDefined();
});

test("a workspace the student stopped offers a way to start it again", () => {
	const workspace = {
		...WORKSPACE,
		state: "stopped" as const,
		desiredState: "stopped" as const,
	};
	expect(startingPhase(workspace)).toBe("stopped");

	renderWithQuery(
		<WorkspaceStarting workspaceId={WORKSPACE.id} workspace={workspace} />,
	);
	expect(screen.getByRole("heading").textContent).toBe("Your workspace is stopped");
	expect(screen.getByTestId("workspace-resume")).toBeDefined();
	// Nothing is happening, so there is no spinner pretending otherwise.
	expect(document.querySelector(".pk-spin")).toBeNull();
});

test("a pending Reset Docker or Rebuild says so instead of the phase", () => {
	renderWithQuery(
		<WorkspaceStarting
			workspaceId={WORKSPACE.id}
			workspace={{ ...WORKSPACE, state: "stopping", pendingOperation: "reset-docker" }}
		/>,
	);
	expect(screen.getByRole("heading").textContent).toBe("Resetting Docker…");
	expect(screen.getByTestId("workspace-progress").dataset.pending).toBe("reset-docker");
});

test("a pending rebuild reads Rebuilding and says projects are kept", () => {
	renderWithQuery(
		<WorkspaceStarting
			workspaceId={WORKSPACE.id}
			workspace={{ ...WORKSPACE, state: "stopped", pendingOperation: "rebuild" }}
		/>,
	);
	expect(screen.getByRole("heading").textContent).toBe("Rebuilding…");
	expect(screen.getByTestId("workspace-progress").textContent).toContain(
		"Your projects and home folder are kept",
	);
});
