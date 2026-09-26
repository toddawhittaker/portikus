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
	const message = "Your workspace ran out of memory, so its terminals were closed.";
	const shown = toast(page, message);
	await expect(shown).toBeVisible({ timeout: 15_000 });
	await expect(shown).toHaveCount(1);
	// Announced, not only shown: warnings are alerts.
	await expect(page.getByRole("alert").filter({ hasText: message })).toBeVisible();
	await expect(page.getByTestId(`terminal-pane-${id}`)).toHaveCount(0);
});

test("open terminals closed by an out-of-memory stop say why once and hand focus to New", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "Live" });
	await page.goto(workspacePath(student.workspaceId, project.id));
	await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
	await newTerminal(page);
	await newTerminal(page);
	await expect
		.poll(async () => (await terminalIds(student.workspaceId, project.id)).length)
		.toBe(2);
	const ids = await terminalIds(student.workspaceId, project.id);
	for (const id of ids) await expectConnected(page, id);
	// The student is typing in the newest terminal.
	await expect(page.locator(".xterm-helper-textarea:focus")).toHaveCount(1);

	// The unit dies: every open pane gets `exit` at once, and the record is
	// written a moment later, after the unit's processes are gone.
	const response = await fetch(`${FAKE_AGENT_URL}/__test/terminals-exit`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			key: student.workspaceId,
			result: "oom-kill",
			terminalIds: ids,
			live: true,
			recordDelayMs: 500,
		}),
	});
	expect(response.ok).toBe(true);

	const message = "Your workspace ran out of memory, so its terminals were closed.";
	const shown = toast(page, message);
	await expect(shown).toBeVisible({ timeout: 15_000 });
	await expect(shown).toHaveCount(1);
	await expect(shown).toContainText("Open a new terminal to carry on.");
	for (const id of ids) {
		await expect(page.getByTestId(`terminal-pane-${id}`)).toHaveCount(0);
	}
	await expect(page.getByTestId("launcher")).toBeFocused();
});
