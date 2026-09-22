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
import type { MeUser } from "../useMe.js";
import { AppHeader } from "./AppHeader.js";

afterEach(() => {
	document.documentElement.removeAttribute("data-theme");
	localStorage.clear();
	vi.unstubAllGlobals();
});

function renderHeader(workspace: Workspace | null = WORKSPACE, user: MeUser = USER) {
	renderWithQuery(
		<AppHeader
			workspaceId={WORKSPACE.id}
			user={user}
			workspace={workspace}
			project={project()}
		/>,
	);
}

function openAccountMenu() {
	fireEvent.pointerDown(screen.getByTestId("me"), { button: 0, ctrlKey: false });
}

test("shows the project in view and the signed-in name, not a workspace button", () => {
	renderHeader();

	expect(screen.getByText("todo-api")).toBeDefined();
	expect(screen.getByText("~/projects/todo-api")).toBeDefined();
	const account = screen.getByTestId("me");
	expect(account.textContent).toContain("AE");
	expect(account.textContent).toContain("Alice Example");
	expect(account.textContent).not.toContain("Student");
	expect(screen.queryByRole("button", { name: "Workspace" })).toBeNull();
	expect(screen.queryByTestId("workspace-status")).toBeNull();
});

test("the account menu has no appearance choices", () => {
	renderHeader();
	openAccountMenu();

	expect(screen.queryByRole("menuitem", { name: "Dark" })).toBeNull();
	expect(screen.queryByRole("menuitem", { name: "Light" })).toBeNull();
	expect(screen.queryByRole("menuitem", { name: "System" })).toBeNull();
});

test("the account menu opens the editor settings dialog (issue #159)", async () => {
	stubFetch(() =>
		json(200, { autoSave: true, autoSaveDelaySeconds: 5, wordWrap: false }),
	);
	renderHeader();
	openAccountMenu();

	fireEvent.click(screen.getByRole("menuitem", { name: "Settings" }));

	const dialog = await screen.findByTestId("dialog-editor-settings");
	expect(dialog.textContent).toContain("Word wrap");
	await waitFor(() =>
		expect(
			(screen.getByTestId("editor-settings-delay") as HTMLInputElement).value,
		).toBe("5"),
	);
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

test("an administrator gets an Administration link that opens in a new tab", () => {
	renderHeader(WORKSPACE, { ...USER, role: "administrator" });
	const account = screen.getByTestId("me");
	expect(account.textContent).toContain("Alice Example");
	expect(account.textContent).not.toContain("Administrator");
	openAccountMenu();

	const link = screen.getByTestId("admin-link");
	expect(link.getAttribute("href")).toBe("/admin");
	expect(link.getAttribute("target")).toBe("_blank");
	expect(link.getAttribute("rel")).toBe("noopener");
});

test("a student gets no Administration link", () => {
	renderHeader();
	openAccountMenu();

	expect(screen.queryByTestId("admin-link")).toBeNull();
});

test("the header has no search button; find in files lives in the files pane (issue #241)", () => {
	renderHeader();

	expect(screen.queryByRole("button", { name: /search/i })).toBeNull();
});
