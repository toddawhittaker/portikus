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
	expect(account.textContent?.replace(/\s+/g, " ").trim()).toBe("AE Alice Example");
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
	expect(account.textContent?.replace(/\s+/g, " ").trim()).toBe("AE Alice Example");
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

// `instructor` joins the contract's Role in Epic 13 T2; cast until then.
const INSTRUCTOR: MeUser = { ...USER, role: "instructor" };
const COURSE = {
	id: "55555555-5555-4555-8555-555555555555",
	title: "CS 101 Intro to Programming",
	platformName: "canvas",
};

test("an instructor with a course gets a Course link and no Administration link", async () => {
	stubFetch((url) => (url === "/courses" ? json(200, [COURSE]) : json(404, {})));
	renderHeader(WORKSPACE, INSTRUCTOR);

	const link = await screen.findByTestId("course-link");
	expect(link.textContent).toBe("Course (opens in a new tab)");
	expect(link.getAttribute("href")).toBe("/course");
	expect(link.getAttribute("target")).toBe("_blank");
	openAccountMenu();
	expect(screen.queryByTestId("admin-link")).toBeNull();
});

test("with no course, the header has no Course link", async () => {
	stubFetch((url) => (url === "/courses" ? json(200, []) : json(404, {})));
	const client = renderWithQuery(
		<AppHeader
			workspaceId={WORKSPACE.id}
			user={USER}
			workspace={WORKSPACE}
			project={project()}
		/>,
	);

	// Wait for the answer, not just the request, before asserting absence.
	await waitFor(() =>
		expect(client.getQueryState(["courses"])?.status).toBe("success"),
	);
	expect(screen.queryByTestId("course-link")).toBeNull();
});

test("the header has no search button; find in files lives in the files pane (issue #241)", () => {
	renderHeader();

	expect(screen.queryByRole("button", { name: /search/i })).toBeNull();
});

/** Issue #300: a saved profile picture replaces the initials. */
test("a saved profile picture shows in the account button instead of initials", async () => {
	stubFetch((url) =>
		url === "/me/profile"
			? json(200, {
					displayName: "Alice Example",
					email: null,
					workspaceLabel: null,
					github: null,
					website: null,
					picture: "/me/picture?v=1",
				})
			: json(404, { code: "NOT_FOUND", message: "no" }),
	);
	renderHeader();

	const picture = await screen.findByTestId("account-picture");
	expect(picture.getAttribute("src")).toBe("/me/picture?v=1");
	expect(screen.getByTestId("me").textContent).not.toContain("AE");
});

test("on the admin page, Open my workspace sits in the account menu where Administration sits (issue #550)", () => {
	renderWithQuery(
		<AppHeader
			user={{ ...USER, role: "administrator" }}
			workspace={null}
			project={undefined}
		/>,
	);
	expect(screen.queryByTestId("open-my-workspace")).toBeNull();
	expect(screen.queryByTestId("back-to-workspace")).toBeNull();
	openAccountMenu();

	const items = screen.getAllByRole("menuitem").map((item) => item.textContent);
	expect(items).toEqual(["Open my workspace", "Notifications", "Settings", "Sign out"]);
	expect(screen.queryByTestId("admin-link")).toBeNull();
});

test("in a workspace, an administrator has no Open my workspace item", () => {
	renderHeader(WORKSPACE, { ...USER, role: "administrator" });
	openAccountMenu();
	expect(screen.queryByTestId("open-my-workspace")).toBeNull();
	expect(screen.queryByTestId("open-my-workspace-status")).toBeNull();
});

function stubUnread(unreadCount: number) {
	stubFetch((url) =>
		url === "/me/notifications"
			? json(200, { notifications: [], unreadCount })
			: json(404, { code: "NOT_FOUND", message: "nope" }),
	);
}

// SPEC.md section 8.5: the unread badge on the account button.
test("the account button names the unread count and the badge shows it", async () => {
	stubUnread(3);
	renderHeader();
	const badge = await screen.findByTestId("notifications-badge");
	expect(badge.textContent).toBe("3");
	expect(badge.getAttribute("aria-label")).toBe(
		"Notifications, 3 unread notifications",
	);
	expect(screen.getByTestId("me").textContent).toContain(", 3 unread notifications");
});

test("the badge reads 9+ above nine and is hidden at zero", async () => {
	stubUnread(12);
	renderHeader();
	expect((await screen.findByTestId("notifications-badge")).textContent).toBe("9+");
});

test("no badge and no count in the name at zero", async () => {
	const fetchMock = stubFetch(() => json(200, { notifications: [], unreadCount: 0 }));
	renderHeader();
	await waitFor(() =>
		expect(fetchMock).toHaveBeenCalledWith("/me/notifications", expect.anything()),
	);
	expect(screen.queryByTestId("notifications-badge")).toBeNull();
	expect(screen.getByTestId("me").textContent).not.toContain("unread");
});

test("the badge and the menu item both open the Notifications dialog", async () => {
	stubUnread(2);
	renderHeader();
	fireEvent.click(await screen.findByTestId("notifications-badge"));
	expect(await screen.findByTestId("dialog-notifications")).toBeDefined();
	fireEvent.click(screen.getByRole("button", { name: "Close" }));
	await waitFor(() => expect(screen.queryByTestId("dialog-notifications")).toBeNull());

	openAccountMenu();
	fireEvent.click(
		screen.getByRole("menuitem", { name: "Notifications (2 unread notifications)" }),
	);
	expect(await screen.findByTestId("dialog-notifications")).toBeDefined();
});

// Closed without reading, the badge still exists and takes focus back; the
// mark-all-read case, where it is gone, is pinned in e2e/notifications.spec.ts.
test("closing the dialog the badge opened returns focus to the badge", async () => {
	stubUnread(2);
	renderHeader();
	fireEvent.click(await screen.findByTestId("notifications-badge"));
	expect(await screen.findByTestId("dialog-notifications")).toBeDefined();
	fireEvent.click(screen.getByRole("button", { name: "Close" }));
	await waitFor(() => expect(screen.queryByTestId("dialog-notifications")).toBeNull());
	await waitFor(() =>
		expect(document.activeElement).toBe(screen.getByTestId("notifications-badge")),
	);
});
