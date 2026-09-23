/**
 * Coding-agent launchers and the URL broker prompt (SPEC.md §10.2,
 * BROWSER-HANDLING.md §18, §25.2).
 */
import { expect, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	pushEvent,
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
