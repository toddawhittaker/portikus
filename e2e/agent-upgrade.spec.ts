/**
 * After a package upgrade the controller restarts each running workspace's
 * agent; the open page reconnects its terminals and tells the student once
 * (issue #887, SPEC.md 22.5).
 */
import { expect, type Page, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	expectConnected,
	newTerminal,
	query,
	settledAxe,
	terminalIds,
	toast,
	WCAG_TAGS,
	workspacePath,
	workTabs,
} from "./helpers";
import { FAKE_AGENT_URL } from "./ports";

const MESSAGE = "Portikus was updated. Your terminals are still running.";

async function restartAgent(terminalId: string, build: string): Promise<void> {
	const response = await fetch(
		`${FAKE_AGENT_URL}/__test/terminals/${terminalId}/agent-restart`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ build }),
		},
	);
	expect(response.ok).toBe(true);
	// The panes drop now and reconnect about three seconds later.
	await expect.poll(() => attachments(terminalId)).toBe(0);
}

async function attachments(terminalId: string): Promise<number> {
	const response = await fetch(
		`${FAKE_AGENT_URL}/__test/terminals/${terminalId}/attachments`,
	);
	return ((await response.json()) as { attachments: number }).attachments;
}

/**
 * The build frame comes before any output, so once a marker line shows in
 * each pane the page has decided about the toast. The count is read once:
 * a retrying assertion would wait out an auto-dismissed toast.
 */
async function expectNoToast(page: Page, paneIds: string[]): Promise<void> {
	for (const id of paneIds) {
		const marker = "settled";
		const printed = await fetch(`${FAKE_AGENT_URL}/__test/terminals/${id}/output`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ lines: [marker] }),
		});
		expect(printed.ok).toBe(true);
		// A hidden tab does not draw its rows, so show the pane first.
		const pane = page.getByTestId(`terminal-pane-${id}`);
		const panel = page.locator("[role=tabpanel]").filter({ has: pane });
		const tabId = await panel.getAttribute("aria-labelledby");
		if (tabId) await page.locator(`[id="${tabId}"]`).click();
		await expect(pane.locator(".xterm-rows")).toContainText(marker);
	}
	expect(await toast(page, MESSAGE).count()).toBe(0);
}

test("an agent upgraded under an open page shows one toast and keeps the terminals", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "Upgrade" });
	await page.goto(workspacePath(student.workspaceId, project.id));
	await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
	await newTerminal(page);
	await newTerminal(page);
	await expect
		.poll(async () => (await terminalIds(student.workspaceId, project.id)).length)
		.toBe(2);
	const ids = await terminalIds(student.workspaceId, project.id);
	for (const id of ids) await expectConnected(page, id);

	// The first build the page hears of is where it starts: no toast.
	for (const id of ids) await restartAgent(id, "fake-build-1");
	for (const id of ids) await expect.poll(() => attachments(id)).toBe(1);
	await expectNoToast(page, ids);

	// The agent restarts on the new build: every pane drops and reconnects.
	for (const id of ids) await restartAgent(id, "fake-build-2");

	const shown = toast(page, MESSAGE);
	await expect(shown).toBeVisible({ timeout: 15_000 });
	// Both panes hear the new build, and the student is told once.
	await expect(shown).toHaveCount(1);
	// It is news, not a warning.
	await expect(shown.getByRole("status")).toBeVisible();
	const results = await (await settledAxe(page)).withTags(WCAG_TAGS).analyze();
	expect(results.violations).toEqual([]);
	for (const id of ids) {
		await expect(page.getByTestId(`terminal-pane-${id}`)).toHaveCount(1);
		await expectConnected(page, id);
	}
});

test("a page opened on an already upgraded agent shows no toast", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "Fresh" });
	await page.goto(workspacePath(student.workspaceId, project.id));
	await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
	await newTerminal(page);
	await expect
		.poll(async () => (await terminalIds(student.workspaceId, project.id)).length)
		.toBe(1);
	const [id] = await terminalIds(student.workspaceId, project.id);
	if (!id) throw new Error("the terminal row was not created");
	await restartAgent(id, "fake-build-3");

	// A reload starts from the build it finds, so nothing changed under it.
	await page.reload();
	await expectConnected(page, id);
	await expect.poll(() => attachments(id)).toBe(1);
	await expectNoToast(page, [id]);
});

test("a workspace stopped and started under an open page shows no toast", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "Restarted" });
	await page.goto(workspacePath(student.workspaceId, project.id));
	await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
	await newTerminal(page);
	await expect
		.poll(async () => (await terminalIds(student.workspaceId, project.id)).length)
		.toBe(1);
	const [id] = await terminalIds(student.workspaceId, project.id);
	if (!id) throw new Error("the terminal row was not created");
	await expectConnected(page, id);
	await restartAgent(id, "fake-build-4");
	await expect.poll(() => attachments(id)).toBe(1);

	// The worker does not run here, so the test moves the row itself.
	await query(
		"update workspaces set state = 'stopped', desired_state = 'stopped', updated_at = now() where id = $1",
		[student.workspaceId],
	);
	await expect(
		page.getByRole("heading", { name: "Your workspace is stopped" }),
	).toBeVisible({ timeout: 15_000 });
	// The started workspace runs a newer agent; that is a fresh start, not an
	// upgrade. The build changes before the row says running, so the page can
	// never attach to the old build after the stop.
	await restartAgent(id, "fake-build-5");
	await query(
		"update workspaces set state = 'running', desired_state = 'running', updated_at = now() where id = $1",
		[student.workspaceId],
	);
	await expect.poll(() => attachments(id), { timeout: 15_000 }).toBe(1);
	await expectConnected(page, id);
	await expectNoToast(page, [id]);
});
