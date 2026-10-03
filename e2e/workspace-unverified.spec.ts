/**
 * When the worker cannot reach the workspace host, the status bar marks the
 * state unconfirmed and says why (SPEC.md §18.3, §25.4, §25.8). The settings
 * column is shared by every parallel test, so the server's message is
 * rewritten in flight instead.
 */
import { expect, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	expectNoViolations,
	workspacePath,
	workTabs,
} from "./helpers";

for (const colorScheme of ["light", "dark"] as const) {
	test(`an unverified state is marked unconfirmed with its reason (${colorScheme})`, async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await createProject(student.workspaceId, { name: "Unverified" });
		await page.routeWebSocket(/\/workspaces\/[^/]+\/ws$/, (socket) => {
			const server = socket.connectToServer();
			server.onMessage((message) => {
				const parsed = JSON.parse(message.toString());
				if (parsed.type === "workspace") parsed.workspace.stateVerified = false;
				socket.send(JSON.stringify(parsed));
			});
		});
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
	});
}

test("a verified state carries no marker", async ({ page, context }) => {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "Verified" });
	await page.goto(workspacePath(student.workspaceId, project.id));
	await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
	await expect(page.getByTestId("workspace-state")).toBeVisible();
	await expect(page.getByTestId("workspace-state-unverified")).toHaveCount(0);
});
