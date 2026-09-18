import type { Workspace } from "@portikus/contracts";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import {
	json,
	project,
	renderWithQuery,
	stubFetch,
	USER,
	WORKSPACE,
} from "../test-utils.js";
import { AppHeader } from "./AppHeader.js";

afterEach(() => {
	document.documentElement.removeAttribute("data-theme");
	localStorage.clear();
	vi.unstubAllGlobals();
});

function renderHeader(workspace: Workspace | null = WORKSPACE) {
	renderWithQuery(
		<AppHeader
			workspaceId={WORKSPACE.id}
			user={USER}
			workspace={workspace}
			project={project()}
		/>,
	);
}

/** Open the "Your workspace" dialog from the header button. */
function openStatus() {
	fireEvent.click(screen.getByTestId("workspace-status"));
}

function openAccountMenu() {
	fireEvent.pointerDown(screen.getByTestId("me"), { button: 0, ctrlKey: false });
}

test("shows the project in view and the workspace state", () => {
	renderHeader();

	expect(screen.getByText("todo-api")).toBeDefined();
	expect(screen.getByText("~/projects/todo-api")).toBeDefined();
	expect(screen.getByTestId("workspace-status").textContent).toContain("Running");
});

test("the appearance items set data-theme and remember the choice", () => {
	renderHeader();
	openAccountMenu();

	fireEvent.click(screen.getByRole("menuitem", { name: "Dark" }));
	expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
	expect(localStorage.getItem("pk-theme")).toBe("dark");

	openAccountMenu();
	fireEvent.click(screen.getByRole("menuitem", { name: "System" }));
	expect(document.documentElement.getAttribute("data-theme")).toBeNull();
	expect(localStorage.getItem("pk-theme")).toBe("system");
});

test("signing out posts a form to the API", () => {
	renderHeader();
	openAccountMenu();

	const item = screen.getByTestId("signout");
	expect(item).toBeDefined();
	const form = document.querySelector("form");
	expect(form?.getAttribute("action")).toBe("/auth/logout");
	expect(form?.getAttribute("method")).toBe("post");
});

test("a running workspace offers restart and stop", () => {
	renderHeader();
	openStatus();

	expect(screen.getByTestId("workspace-restart")).toBeDefined();
	expect(screen.getByTestId("workspace-stop")).toBeDefined();
	expect(screen.queryByTestId("workspace-start")).toBeNull();
});

test("a stopped workspace offers start only", () => {
	renderHeader({ ...WORKSPACE, state: "stopped", desiredState: "stopped" });
	openStatus();

	expect(screen.getByTestId("workspace-start")).toBeDefined();
	expect(screen.queryByTestId("workspace-stop")).toBeNull();
});

test("a workspace in transition shows it and disables the buttons", () => {
	renderHeader({ ...WORKSPACE, state: "running", desiredState: "stopped" });
	openStatus();

	expect(screen.getByTestId("workspace-transition").textContent).toBe(
		"Stopping your workspace.",
	);
	expect(screen.getByTestId("workspace-stop").hasAttribute("disabled")).toBe(true);
	expect(screen.getByTestId("workspace-restart").hasAttribute("disabled")).toBe(true);
});

test("stopping asks for confirmation, then posts to the stop route", async () => {
	const fetchMock = stubFetch(() => json(202, { ok: true }));
	renderHeader();
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
	renderHeader({ ...WORKSPACE, state: "stopped", desiredState: "stopped" });
	openStatus();

	fireEvent.click(screen.getByTestId("workspace-start"));

	await waitFor(() => expect(fetchMock).toHaveBeenCalled());
	expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
		`/workspaces/${WORKSPACE.id}/start`,
	);
});

test("a long image fingerprint is shortened and kept in full in the title", () => {
	const fingerprint = "a".repeat(64);
	renderHeader({ ...WORKSPACE, imageVersion: fingerprint });
	openStatus();

	const cell = screen.getByTestId("workspace-status-image");
	expect(cell.textContent).toBe(`${"a".repeat(12)}…`);
	expect(cell.getAttribute("title")).toBe(fingerprint);
});
