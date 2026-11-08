import { expect, type Page, test } from "@playwright/test";
import { join, newCourse } from "./course-profile-helpers";
import {
	createProject,
	createStudent,
	expectConnected,
	newTerminal,
	terminalIds,
	workspacePath,
	workTabs,
} from "./helpers";
import { splitPane } from "./split-helpers";

/**
 * The pane menu's Split right and Split down ask what to open, with the New
 * tab menu's choices, and the tab, header and content of a split agree
 * (SPEC.md §8.7, §9.3, §10.8, §25.8).
 */

/** Open a project with one chat pane, from the New tab menu. */
async function openChat(page: Page, workspaceId: string) {
	const project = await createProject(workspaceId, { name: "Splits" });
	await page.goto(workspacePath(workspaceId, project.id));
	await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
	await page.getByTestId("launcher").click();
	await page.getByTestId("launcher-claude-gui").click();
	await expect
		.poll(async () => (await terminalIds(workspaceId, project.id)).length)
		.toBe(1);
	const [chat] = await terminalIds(workspaceId, project.id);
	if (!chat) throw new Error("the chat row was not created");
	await expect(page.getByTestId(`chat-view-${chat}`)).toBeVisible({ timeout: 15_000 });
	return { project, chat };
}

/** The id of the one terminal that is not `known`, once it exists. */
async function newId(workspaceId: string, projectId: string, known: string) {
	await expect
		.poll(async () => (await terminalIds(workspaceId, projectId)).length)
		.toBe(2);
	const id = (await terminalIds(workspaceId, projectId)).find((item) => item !== known);
	if (!id) throw new Error("the split's terminal was not created");
	return id;
}

test("a terminal split from a chat pane: the keyboard way, and tab, header and content agree", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const { project, chat } = await openChat(page, student.workspaceId);
	const tab = workTabs(page).getByRole("tab");
	await expect(tab).toHaveText(/Claude Code \(GUI\)/);

	await page.getByTestId(`terminal-actions-${chat}`).focus();
	await page.keyboard.press("Enter");
	const split = page.getByTestId("split-right");
	await expect(split).toBeFocused();
	// Right arrow opens the submenu, Escape steps back to the pane menu.
	await page.keyboard.press("ArrowRight");
	const sub = page.getByRole("menu", { name: "Split right" });
	await expect(sub).toBeVisible();
	await expect(sub.getByTestId("split-right-claude-gui")).toBeVisible();
	await expect(sub.getByTestId("split-right-claude")).toBeVisible();
	await expect(sub.getByTestId("split-right-codex")).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(sub).toBeHidden();
	await expect(split).toBeFocused();
	// Enter opens it too; the first choice is Terminal.
	await page.keyboard.press("Enter");
	await expect(sub.getByTestId("split-right-terminal")).toBeVisible();
	await expect(page.getByRole("menuitem", { name: "Terminal" })).toBeFocused();
	await page.keyboard.press("Enter");

	const shell = await newId(student.workspaceId, project.id, chat);
	await expectConnected(page, shell);
	// The keyboard is in the new shell, and the tab names the pane it is in.
	await expect(
		page
			.getByTestId(`terminal-pane-${shell}`)
			.locator("textarea.xterm-helper-textarea"),
	).toBeFocused();
	const header = await page.getByTestId(`terminal-handle-${shell}`).textContent();
	const name = (header ?? "").split(" · ")[0] ?? "";
	expect(name).toMatch(/^Terminal \d+$/);
	await expect(tab).toHaveText(new RegExp(name));
	await expect(tab).not.toHaveText(/Claude Code/);
	await expect(page.getByTestId(`chat-view-${shell}`)).toHaveCount(0);
});

test("Split down with Claude Code (GUI) opens a chat in the same project, its composer focused", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "Chat split" });
	await page.goto(workspacePath(student.workspaceId, project.id));
	await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
	await newTerminal(page);
	await expect
		.poll(async () => (await terminalIds(student.workspaceId, project.id)).length)
		.toBe(1);
	const [shell] = await terminalIds(student.workspaceId, project.id);
	if (!shell) throw new Error("the terminal row was not created");
	await expectConnected(page, shell);

	const posted = page.waitForRequest(
		(request) => request.method() === "POST" && request.url().includes("/terminals"),
	);
	await splitPane(page, shell, "down", "claude-gui");
	expect((await posted).postDataJSON()).toEqual({
		projectId: project.id,
		kind: "chat",
		agent: "claude",
	});

	const chat = await newId(student.workspaceId, project.id, shell);
	const view = page.getByTestId(`chat-view-${chat}`);
	await expect(view).toBeVisible({ timeout: 15_000 });
	await expect(view.getByTestId("chat-composer-input")).toBeFocused();
	await expect(workTabs(page).getByRole("tab")).toHaveCount(1);
	await expect(workTabs(page).getByRole("tab")).toHaveText(/Claude Code \(GUI\)/);
});

test("the Traditional profile's split offers only a terminal", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await join((await newCourse("traditional")).id, student.userId, "student");
	const project = await createProject(student.workspaceId, { name: "Traditional" });
	const settings = page.waitForResponse(
		(response) => new URL(response.url()).pathname === "/me/settings",
	);
	await page.goto(workspacePath(student.workspaceId, project.id));
	await settings;
	await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
	await newTerminal(page);
	await expect
		.poll(async () => (await terminalIds(student.workspaceId, project.id)).length)
		.toBe(1);
	const [shell] = await terminalIds(student.workspaceId, project.id);
	if (!shell) throw new Error("the terminal row was not created");

	await page.getByTestId(`terminal-actions-${shell}`).click();
	await page.getByTestId("split-right").click();
	await expect(page.getByTestId("split-right-terminal")).toBeVisible();
	await expect(page.getByTestId("split-right-claude")).toHaveCount(0);
	await expect(page.getByTestId("split-right-claude-gui")).toHaveCount(0);
	await expect(page.getByTestId("split-right-codex")).toHaveCount(0);
});
