import type { Workspace } from "@portikus/contracts";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { json, renderWithQuery, stubFetch, WORKSPACE } from "../test-utils.js";
import { StatusBar } from "./StatusBar.js";

afterEach(() => {
	vi.unstubAllGlobals();
});

function renderBar(workspace: Workspace | null = WORKSPACE) {
	renderWithQuery(
		<StatusBar workspaceId={WORKSPACE.id} project={undefined} workspace={workspace} />,
	);
}

/** Open the "Your workspace" dialog from the state button. */
function openStatus() {
	fireEvent.click(screen.getByTestId("workspace-status"));
}

test("the state is a button labelled with the workspace state, and the leave-terminal hint is gone", () => {
	renderBar();

	const button = screen.getByTestId("workspace-status");
	expect(button.tagName).toBe("BUTTON");
	expect(screen.getByTestId("workspace-state").textContent).toBe("Running");
	expect(screen.queryByText(/Leave terminal/)).toBeNull();
});

test("a stopped workspace is labelled Stopped", () => {
	renderBar({ ...WORKSPACE, state: "stopped", desiredState: "stopped" });

	expect(screen.getByTestId("workspace-state").textContent).toBe("Stopped");
});

test("no workspace yet reads as Connecting", () => {
	renderBar(null);

	expect(screen.getByTestId("workspace-state").textContent).toBe("Connecting");
});

test("a running workspace offers restart and stop", () => {
	renderBar();
	openStatus();

	expect(screen.getByTestId("dialog-workspace-status")).toBeDefined();
	expect(screen.getByTestId("workspace-restart")).toBeDefined();
	expect(screen.getByTestId("workspace-stop")).toBeDefined();
	expect(screen.queryByTestId("workspace-start")).toBeNull();
});

test("a stopped workspace offers start only", () => {
	renderBar({ ...WORKSPACE, state: "stopped", desiredState: "stopped" });
	openStatus();

	expect(screen.getByTestId("workspace-start")).toBeDefined();
	expect(screen.queryByTestId("workspace-stop")).toBeNull();
});

test("a workspace in transition shows it and disables the buttons", () => {
	renderBar({ ...WORKSPACE, state: "running", desiredState: "stopped" });
	openStatus();

	expect(screen.getByTestId("workspace-state").textContent).toBe("Stopping");
	expect(screen.getByTestId("workspace-transition").textContent).toBe(
		"Stopping your workspace.",
	);
	expect(screen.getByTestId("workspace-stop").hasAttribute("disabled")).toBe(true);
	expect(screen.getByTestId("workspace-restart").hasAttribute("disabled")).toBe(true);
});

test("stopping asks for confirmation, then posts to the stop route", async () => {
	const fetchMock = stubFetch(() => json(202, { ok: true }));
	renderBar();
	openStatus();

	fireEvent.click(screen.getByTestId("workspace-stop"));
	expect(screen.getByTestId("dialog-workspace-stop").textContent).toContain(
		"Your files are kept",
	);
	expect(fetchMock).not.toHaveBeenCalled();

	fireEvent.click(screen.getByRole("button", { name: "Stop workspace" }));

	await waitFor(() => expect(fetchMock).toHaveBeenCalled());
	const [url, init] = fetchMock.mock.calls[0] ?? [];
	expect(String(url)).toBe(`/workspaces/${WORKSPACE.id}/stop`);
	expect((init as RequestInit).method).toBe("POST");
	// The dialog stays open so the new state can appear in it.
	expect(screen.getByTestId("dialog-workspace-status")).toBeDefined();
});

test("starting needs no confirmation", async () => {
	const fetchMock = stubFetch(() => json(202, { ok: true }));
	renderBar({ ...WORKSPACE, state: "stopped", desiredState: "stopped" });
	openStatus();

	fireEvent.click(screen.getByTestId("workspace-start"));

	await waitFor(() => expect(fetchMock).toHaveBeenCalled());
	expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
		`/workspaces/${WORKSPACE.id}/start`,
	);
});

test("a long image fingerprint is shortened and kept in full in the title", () => {
	const fingerprint = "a".repeat(64);
	renderBar({ ...WORKSPACE, imageVersion: fingerprint });
	openStatus();

	const cell = screen.getByTestId("workspace-status-image");
	expect(cell.textContent).toBe(`${"a".repeat(12)}…`);
	expect(cell.getAttribute("title")).toBe(fingerprint);
});
