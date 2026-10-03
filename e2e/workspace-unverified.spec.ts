/**
 * When the worker cannot reach the workspace host, the status bar marks the
 * state unconfirmed and says why (SPEC.md §18.3, §25.4, §25.8). The settings
 * column is shared by every parallel test, so the server's message is
 * rewritten in flight instead.
 */
import { expect, type Page, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	expectNoViolations,
	seedStorage,
	workspacePath,
	workTabs,
} from "./helpers";

const GIB = 1024 ** 3;

/** Rewrite every workspace push so the state reads unverified. */
async function markUnverified(page: Page) {
	await page.routeWebSocket(/\/workspaces\/[^/]+\/ws$/, (socket) => {
		const server = socket.connectToServer();
		server.onMessage((message) => {
			const parsed = JSON.parse(message.toString());
			if (parsed.type === "workspace") parsed.workspace.stateVerified = false;
			socket.send(JSON.stringify(parsed));
		});
	});
}

for (const colorScheme of ["light", "dark"] as const) {
	test(`an unverified state is marked unconfirmed with its reason (${colorScheme})`, async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await createProject(student.workspaceId, { name: "Unverified" });
		await markUnverified(page);
		await page.emulateMedia({ colorScheme });
		await page.goto(workspacePath(student.workspaceId, project.id));
		await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });

		const marker = page.getByTestId("workspace-state-unverified");
		await expect(marker).toBeVisible();
		await expect(marker).toContainText("unconfirmed");
		await expect(page.getByTestId("workspace-status")).toHaveAccessibleName(
			/unconfirmed\. Portikus can't reach the workspace host right now, so this may be out of date\./,
		);
		await expectNoViolations(page, '[data-testid="workspace-status"]');
		await expect(page.getByTestId("state-unverified-announce")).toHaveText(
			"Workspace state is unconfirmed. Portikus can't reach the workspace host right now.",
		);

		// The button follows the theme rather than one fixed colour.
		const button = page.getByTestId("workspace-status");
		const colour = await button.evaluate((node) => getComputedStyle(node).color);
		await page.emulateMedia({
			colorScheme: colorScheme === "light" ? "dark" : "light",
		});
		await expect(button).not.toHaveCSS("color", colour);
		await page.emulateMedia({ colorScheme });
		await expect(button).toHaveCSS("color", colour);

		await page.getByTestId("workspace-status").click();
		const dialog = page.getByTestId("dialog-workspace-status");
		await expect(dialog.getByTestId("workspace-status-unverified")).toHaveText(
			"Portikus can't reach the workspace host right now, so this may be out of date.",
		);
		await expectNoViolations(page, '[data-testid="dialog-workspace-status"]');
	});
}

// The workspace page keeps a 1024 px floor (.pk-root), so at 320 px the page
// scrolls sideways; what must hold is that nothing in the bar is clipped.
test("at 320 px the status bar with meters, a storage warning and the marker clips nothing (WCAG 1.4.10)", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await seedStorage(student.workspaceId, {
		home: { usedBytes: 88 * GIB, totalBytes: 100 * GIB },
	});
	await markUnverified(page);
	await page.setViewportSize({ width: 320, height: 720 });
	await page.goto(workspacePath(student.workspaceId));
	await expect(page.getByTestId("storage-warning")).toBeVisible({ timeout: 15_000 });
	await expect(page.getByTestId("disk-meter")).toBeVisible();
	await expect(page.getByTestId("workspace-state-unverified")).toBeVisible();
	await expect(page.getByTestId("workspace-status")).toHaveAccessibleName(
		/unconfirmed\./,
	);

	const sizes = await page
		.getByTestId("status-bar")
		.evaluate((node) => ({ scroll: node.scrollWidth, client: node.clientWidth }));
	expect(sizes.scroll).toBeLessThanOrEqual(sizes.client);
	const bar = await page.getByTestId("status-bar").boundingBox();
	const button = await page.getByTestId("workspace-status").boundingBox();
	if (!bar || !button) throw new Error("the status bar has no box");
	expect(button.x + button.width).toBeLessThanOrEqual(bar.x + bar.width);
});

test("a verified state carries no marker", async ({ page, context }) => {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "Verified" });
	await page.goto(workspacePath(student.workspaceId, project.id));
	await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
	await expect(page.getByTestId("workspace-state")).toBeVisible();
	await expect(page.getByTestId("workspace-state-unverified")).toHaveCount(0);
});
