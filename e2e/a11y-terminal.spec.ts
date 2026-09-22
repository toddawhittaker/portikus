/**
 * The terminal tells assistive technology how to leave it and announces
 * connection changes (SPEC.md §25.8; issues #359 and #363).
 */
import { expect, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	expectConnected,
	terminalIds,
	workspacePath,
	workTabs,
} from "./helpers";

test("the terminal input names Alt+Shift+Q as the way out", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "A11y Leave" });
	await page.goto(workspacePath(student.workspaceId, project.id));
	await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });

	await page.getByTestId("launcher").click();
	await page.getByTestId("launcher-terminal").click();
	await expect(page.getByRole("tab", { name: "Terminal 1" })).toBeVisible();
	const [id] = await terminalIds(student.workspaceId, project.id);
	if (!id) throw new Error("the terminal row was not created");
	await expectConnected(page, id);

	const input = page.locator(
		`[data-testid="terminal-pane-${id}"] .xterm-helper-textarea`,
	);
	await expect(input).toHaveAccessibleDescription(/Alt\+Shift\+Q/);
});

test("a lost connection is announced from a status region", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "A11y Lost" });
	// A server error close is not retried, so the pane gives up at once.
	await page.routeWebSocket(/\/terminals\/[^/]+\/ws/, (socket) => {
		socket.close({ code: 1011 });
	});
	await page.goto(workspacePath(student.workspaceId, project.id));
	await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });

	await page.getByTestId("launcher").click();
	await page.getByTestId("launcher-terminal").click();
	await expect(page.getByRole("tab", { name: "Terminal 1" })).toBeVisible();
	const [id] = await terminalIds(student.workspaceId, project.id);
	if (!id) throw new Error("the terminal row was not created");

	const status = page.getByTestId(`terminal-pane-${id}`).getByRole("status");
	await expect(status).toContainText("This terminal lost its connection");
});
