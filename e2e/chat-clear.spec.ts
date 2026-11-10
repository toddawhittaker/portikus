import { expect, test } from "@playwright/test";
import { makeChatTab } from "./chat-helpers";
import { workspacePath } from "./helpers";

/**
 * /clear starts a new Claude session (SPEC.md §10.8): the conversation
 * empties at once and stays empty after a reload, because the host now
 * replays the new session.
 */
test("/clear empties the conversation, and a reload keeps it empty", async ({
	page,
	context,
}) => {
	test.setTimeout(60_000);
	const { student, project, id } = await makeChatTab(page, context);
	await page.goto(workspacePath(student.workspaceId, project.id));
	const view = page.getByTestId(`chat-view-${id}`);
	await expect(view).toBeVisible({ timeout: 15_000 });
	await expect(view.getByText("Earlier answer")).toBeVisible();

	const box = view.getByTestId("chat-composer-input");
	await box.fill("/clear");
	await box.press("Enter");
	await expect(view.getByText("Earlier answer")).toHaveCount(0);
	await expect(view.getByText("Earlier question")).toHaveCount(0);

	await page.reload();
	await expect(view).toBeVisible({ timeout: 15_000 });
	await expect(view.getByTestId("chat-composer-input")).toBeVisible();
	await expect(view.getByText("Earlier answer")).toHaveCount(0);
	await expect(view.getByText("Earlier question")).toHaveCount(0);
});
