import { type BrowserContext, expect, type Page } from "@playwright/test";
import {
	createProject,
	createStudent,
	newTerminal,
	query,
	terminalIds,
	workspacePath,
	workTabs,
} from "./helpers";

/**
 * A chat tab in a new student's workspace. The launcher entry is the
 * composer's, so a terminal is opened and its row made a chat; the fake
 * agent already knows the terminal, and the API reads the kind from the row.
 */
export async function makeChatTab(page: Page, context: BrowserContext) {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "Dashboard" });
	await page.goto(workspacePath(student.workspaceId, project.id));
	await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
	await newTerminal(page);
	await expect
		.poll(async () => (await terminalIds(student.workspaceId, project.id)).length)
		.toBe(1);
	const [id] = await terminalIds(student.workspaceId, project.id);
	await query(
		"update terminals set kind = 'chat', agent = 'claude', name = 'Claude Code' where id = $1",
		[id],
	);
	if (!id) throw new Error("the terminal row was not created");
	return { student, project, id };
}
