import { expect, type Locator, type Page, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	expectConnected,
	newTerminal,
	terminalIds,
	workspacePath,
	workTabs,
} from "./helpers";

/**
 * The workspace timezone (issue #287, SPEC.md §13.5). The zone is a per-user
 * setting; a terminal opened after it changed runs in the new zone, which the
 * fake workspace agent shows by answering `date` in the zone it was created
 * with.
 */

const ZONE = "America/Los_Angeles";

/** What `date` prints in a zone, worked out the same way the fake agent does. */
function abbreviation(zone: string): string {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: zone,
		timeZoneName: "short",
	}).formatToParts(new Date());
	const name = parts.find((part) => part.type === "timeZoneName")?.value;
	if (!name) throw new Error(`no zone name for ${zone}`);
	return name;
}

function rowsOf(page: Page, terminalId: string): Locator {
	return page.locator(`[data-testid=terminal-pane-${terminalId}] .xterm-rows`);
}

async function typeInTerminal(page: Page, text: string): Promise<void> {
	await page.locator(".pk-termgroup:not([hidden]) .pk-term .xterm-screen").click();
	await page.keyboard.insertText(text);
	await page.keyboard.press("Enter");
}

test("a student can change the workspace timezone and a new terminal uses it", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "Clock" });
	await page.goto(workspacePath(student.workspaceId, project.id));
	await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });

	// The dialog opens on the zone the deployment starts everyone in.
	await page.getByTestId("me").click();
	await page.getByRole("menuitem", { name: "Editor settings" }).click();
	await expect(page.getByTestId("dialog-editor-settings")).toBeVisible();
	await expect(page.getByLabel("Workspace timezone")).toContainText("America/New York");

	await page.getByLabel("Workspace timezone").click();
	await page.getByRole("option", { name: "Los Angeles", exact: true }).click();
	await page.getByTestId("editor-settings-save").click();
	await expect(page.getByTestId("dialog-editor-settings")).toHaveCount(0);

	// A terminal opened after the change runs in the new zone.
	await newTerminal(page);
	await expect(page.getByRole("tab", { name: "Terminal 1" })).toBeVisible();
	const [terminalId] = await terminalIds(student.workspaceId);
	if (!terminalId) throw new Error("the terminal row was not created");
	await expectConnected(page, terminalId);

	const rows = rowsOf(page, terminalId);
	const expected = abbreviation(ZONE);
	await expect
		.poll(
			async () => {
				const seen = (await rows.textContent()) ?? "";
				if (seen.includes(expected)) return seen;
				await typeInTerminal(page, "date");
				await page.waitForTimeout(500);
				return (await rows.textContent()) ?? "";
			},
			{ timeout: 20_000, intervals: [200, 500, 1000, 2000] },
		)
		.toContain(expected);

	// The choice is the student's own, so it survives a reload.
	await page.reload();
	await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
	await page.getByTestId("me").click();
	await page.getByRole("menuitem", { name: "Editor settings" }).click();
	await expect(page.getByLabel("Workspace timezone")).toContainText("Los Angeles");
});
