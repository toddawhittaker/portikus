/**
 * A user at the terminal socket cap is told why the terminal cannot connect
 * (SPEC.md §24.13). The server's refusal is mocked with its close code: the
 * real cap is sixty sockets, and its counting is pinned by the API tests.
 */
import { expect, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	terminalIds,
	workspacePath,
	workTabs,
} from "./helpers";

test("a terminal refused for too many connections says so", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "Socket Cap" });
	await page.routeWebSocket(/\/terminals\/[^/]+\/ws/, (socket) => {
		socket.close({ code: 4429 });
	});
	await page.goto(workspacePath(student.workspaceId, project.id));
	await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });

	await page.getByTestId("launcher").click();
	await page.getByTestId("launcher-terminal").click();
	await expect(page.getByRole("tab", { name: "Terminal 1" })).toBeVisible();
	const [id] = await terminalIds(student.workspaceId, project.id);
	if (!id) throw new Error("the terminal row was not created");

	const status = page.getByTestId(`terminal-pane-${id}`).getByRole("status");
	await expect(status).toContainText("You have too many terminals open");
	await expect(status).not.toContainText("Reconnecting");
});
