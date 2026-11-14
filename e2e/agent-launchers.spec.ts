/**
 * Coding-agent launchers and the URL broker prompt (SPEC.md §10.2,
 * BROWSER-HANDLING.md §18, §25.2).
 */
import { expect, test } from "@playwright/test";
import { join, newCourse } from "./course-profile-helpers";
import {
	createProject,
	createStudent,
	expectNoViolations,
	pushEvent,
	terminalIds,
	workspacePath,
	workTabs,
} from "./helpers";

test("Claude Code starts from the New menu", async ({ page, context }) => {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "Agent Launch" });
	await page.goto(workspacePath(student.workspaceId, project.id));
	await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });

	const posted = page.waitForRequest(
		(request) => request.method() === "POST" && request.url().includes("/terminals"),
	);
	await page.getByTestId("launcher").click();
	await page.getByTestId("launcher-claude").click();
	const request = await posted;
	expect(request.postDataJSON()).toEqual({
		projectId: project.id,
		agent: "claude",
	});
	expect(request.postData() ?? "").not.toContain("command");
	await expect(page.getByRole("tab", { name: /Claude Code/ })).toBeVisible();
});

/** The empty work area offers the launcher's two main actions. */
test("the empty work area's buttons open a terminal and Claude Code", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "Empty Start" });
	await page.goto(workspacePath(student.workspaceId, project.id));
	await expect(page.getByText("No terminals open")).toBeVisible({ timeout: 15_000 });
	await expect(page.getByTestId("launcher")).toHaveAccessibleName("New tab");

	await page.getByRole("button", { name: "Open a terminal" }).click();
	await expect(page.getByRole("tab", { name: /Terminal/ })).toBeVisible();

	const posted = page.waitForRequest(
		(request) => request.method() === "POST" && request.url().includes("/terminals"),
	);
	// The work area is no longer empty, so reach Claude Code through a fresh project.
	const other = await createProject(student.workspaceId, { name: "Empty Agent" });
	await page.goto(workspacePath(student.workspaceId, other.id));
	await page.getByRole("button", { name: "Start Claude Code" }).click();
	expect((await posted).postDataJSON()).toEqual({
		projectId: other.id,
		agent: "claude",
	});
	await expect(page.getByRole("tab", { name: /Claude Code/ })).toBeVisible();
});

test("a javascript URL is refused and an https URL opens only after the click", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "Broker" });
	await page.goto(workspacePath(student.workspaceId, project.id));
	await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });

	const javascript = {
		type: "browser.open.request",
		requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		workspaceId: student.workspaceId,
		url: "javascript:alert(1)",
		brokerClass: "external",
		requestedAt: "2026-01-01T00:00:00.000Z",
	};
	// A subscriber can be a socket that is already closing (React's development
	// double mount opens one and drops it), so a frame it takes can be lost.
	// Push again until the dialog shows; the page ignores a repeated requestId.
	const dialog = page.getByTestId("browser-open-dialog");
	await expect
		.poll(
			async () => {
				await pushEvent(student.workspaceId, project.slug, javascript);
				return dialog.isVisible();
			},
			{ timeout: 15_000 },
		)
		.toBe(true);
	await expect(dialog).toBeVisible();
	await expect(page.getByTestId("browser-open-confirm")).toHaveCount(0);
	await page.getByTestId("browser-open-cancel").click();
	await expect(page.getByTestId("browser-open-dialog")).toHaveCount(0);

	let popped = false;
	page.on("popup", () => {
		popped = true;
	});
	const https = {
		...javascript,
		requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
		url: "https://example.com/login?code=secret",
	};
	await expect
		.poll(
			async () => {
				await pushEvent(student.workspaceId, project.slug, https);
				return dialog.isVisible();
			},
			{ timeout: 15_000 },
		)
		.toBe(true);
	await expect(page.getByTestId("browser-open-origin")).toHaveText(
		"https://example.com",
	);
	expect(popped).toBe(false);
	const popupPromise = page.waitForEvent("popup");
	await page.getByTestId("browser-open-confirm").click();
	const popup = await popupPromise;
	expect(popped).toBe(true);
	expect(popup.url()).toContain("https://example.com/");
});

test("the New menu offers each agent's GUI and TUI, and Codex (GUI) opens a Codex chat", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "Four launchers" });
	await page.goto(workspacePath(student.workspaceId, project.id));
	await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
	await page.getByTestId("launcher").click();
	const menu = page.getByRole("menu", { name: "New tab" });
	await expect(menu.getByRole("menuitem")).toHaveText([
		/Terminal/,
		"Claude Code (GUI)",
		"Claude Code (TUI)",
		"Codex (GUI)",
		"Codex (TUI)",
		"Preview",
	]);
	const posted = page.waitForRequest(
		(request) => request.method() === "POST" && request.url().includes("/terminals"),
	);
	await page.getByTestId("launcher-codex-gui").click();
	expect((await posted).postDataJSON()).toEqual({
		projectId: project.id,
		kind: "chat",
		agent: "codex",
	});
	await expect(page.getByRole("tab", { name: /Codex \(GUI\)/ })).toBeVisible();
});

test("Codex (TUI) starts a Codex terminal, and Codex (GUI) a chat that names Codex", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "Codex launch" });
	await page.goto(workspacePath(student.workspaceId, project.id));
	await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });

	const posted = page.waitForRequest(
		(request) => request.method() === "POST" && request.url().includes("/terminals"),
	);
	await page.getByTestId("launcher").click();
	await page.getByTestId("launcher-codex").click();
	// A terminal runs the program with no kind, and no command of the page's own.
	const body = (await posted).postDataJSON();
	expect(body).toEqual({ projectId: project.id, agent: "codex" });
	await expect(page.getByRole("tab", { name: /Codex \(TUI\)/ })).toBeVisible();
	await expect(page.locator('[data-testid^="chat-view-"]')).toHaveCount(0);

	await page.getByTestId("launcher").click();
	await page.getByTestId("launcher-codex-gui").click();
	await expect(page.getByRole("tab", { name: /Codex \(GUI\)/ })).toBeVisible();
	await expect
		.poll(async () => (await terminalIds(student.workspaceId, project.id)).length)
		.toBe(2);
	const chat = page.locator('[data-testid^="chat-view-"]');
	await expect(chat).toBeVisible({ timeout: 15_000 });
	await expect(chat.getByTestId("chat-composer-input")).toHaveAttribute(
		"aria-label",
		"Message Codex",
	);
	await expect(page.getByRole("region", { name: /^Chat: / })).toBeVisible();
});

for (const colorScheme of ["dark", "light"] as const) {
	test(`the New menu reads well and each agent launcher is a menu item (${colorScheme})`, async ({
		page,
		context,
	}) => {
		await page.emulateMedia({ colorScheme });
		const student = await createStudent(context);
		const project = await createProject(student.workspaceId, { name: "Menu look" });
		await page.goto(workspacePath(student.workspaceId, project.id));
		await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
		await page.getByTestId("launcher").click();
		const menu = page.getByRole("menu", { name: "New tab" });
		for (const name of [
			"Claude Code (GUI)",
			"Claude Code (TUI)",
			"Codex (GUI)",
			"Codex (TUI)",
		]) {
			await expect(menu.getByRole("menuitem", { name })).toBeVisible();
		}
		await expectNoViolations(page, '[role="menu"]');
	});
}

test("the Traditional profile hides all four agent launchers", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await join((await newCourse("traditional")).id, student.userId, "student");
	const project = await createProject(student.workspaceId, { name: "No agents" });
	const settings = page.waitForResponse(
		(response) => new URL(response.url()).pathname === "/me/settings",
	);
	await page.goto(workspacePath(student.workspaceId, project.id));
	await settings;
	await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
	await page.getByTestId("launcher").click();
	const menu = page.getByRole("menu", { name: "New tab" });
	await expect(menu.getByRole("menuitem")).toHaveText([/Terminal/, "Preview"]);
	for (const testId of [
		"launcher-claude-gui",
		"launcher-claude",
		"launcher-codex-gui",
		"launcher-codex",
	]) {
		await expect(page.getByTestId(testId)).toHaveCount(0);
	}
});
