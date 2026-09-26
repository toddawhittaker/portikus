/**
 * Terminals lost to a restart of the workspace's terminals unit are
 * explained in a toast rather than vanishing silently (SPEC.md §9.7, #625).
 */
import { expect, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	expectConnected,
	newTerminal,
	terminalIds,
	toast,
	workspacePath,
	workTabs,
} from "./helpers";
import { FAKE_AGENT_URL } from "./ports";

test("a terminal lost to an out-of-memory restart shows its toast", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "Restart" });
	await page.goto(workspacePath(student.workspaceId, project.id));
	await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
	await newTerminal(page);
	await expect
		.poll(async () => (await terminalIds(student.workspaceId, project.id)).length)
		.toBe(1);
	const [id] = await terminalIds(student.workspaceId, project.id);
	if (!id) throw new Error("the terminal row was not created");
	await expectConnected(page, id);

	// The terminals unit is killed for memory: its record is written and the
	// terminal's session is gone.
	const response = await fetch(`${FAKE_AGENT_URL}/__test/terminals-exit`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			key: student.workspaceId,
			result: "oom-kill",
			terminalId: id,
		}),
	});
	expect(response.ok).toBe(true);

	await page.reload();
	const message = "Your workspace ran out of memory and its terminals were restarted.";
	const shown = toast(page, message);
	await expect(shown).toBeVisible({ timeout: 15_000 });
	await expect(shown).toHaveCount(1);
	// Announced, not only shown: warnings are alerts.
	await expect(page.getByRole("alert").filter({ hasText: message })).toBeVisible();
	await expect(page.getByTestId(`terminal-pane-${id}`)).toHaveCount(0);
});
