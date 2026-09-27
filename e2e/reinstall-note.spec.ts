import { expect, test } from "@playwright/test";
import { createStudent, settledAxe, toast, WCAG_TAGS, workspacePath } from "./helpers";
import { FAKE_AGENT_URL } from "./ports";

/**
 * The reinstall note after a rebuild (SPEC.md §22.3, ADR 0042). The fake
 * agent stands in for the agent's comparison of the apt list with the
 * running image; each test seeds what it would answer.
 */

async function seedNote(workspaceId: string, packages: string[]): Promise<void> {
	const response = await fetch(`${FAKE_AGENT_URL}/__test/reinstall-note`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ key: workspaceId, packages }),
	});
	if (!response.ok)
		throw new Error(`the fake agent refused the note: ${response.status}`);
}

async function agentNote(workspaceId: string): Promise<string[]> {
	const response = await fetch(
		`${FAKE_AGENT_URL}/__test/reinstall-note?key=${workspaceId}`,
	);
	return ((await response.json()) as { packages: string[] }).packages;
}

test("after a rebuild the student sees what to reinstall and can copy the line", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await seedNote(student.workspaceId, ["python3-venv", "htop"]);
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);

	await page.goto(workspacePath(student.workspaceId));

	const notice = page.getByTestId("reinstall-notice");
	await expect(notice).toBeVisible({ timeout: 15_000 });
	await expect(notice).toContainText(
		"Packages you had installed with sudo apt were removed when your workspace was rebuilt",
	);
	await expect(notice.getByTestId("reinstall-packages")).toHaveText(
		"python3-venv, htop",
	);
	await expect(notice).toContainText("Reinstall them with:");
	await expect(notice.getByTestId("reinstall-command")).toHaveText(
		"sudo apt install python3-venv htop",
	);

	for (const scheme of ["light", "dark"] as const) {
		await page.emulateMedia({ colorScheme: scheme });
		const results = await (await settledAxe(page))
			.include('[data-testid="reinstall-notice"]')
			.withTags(WCAG_TAGS)
			.analyze();
		expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
	}

	await notice.getByRole("button", { name: "Copy command" }).click();
	await expect(toast(page, "Command copied")).toBeVisible();
	expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
		"sudo apt install python3-venv htop",
	);
});

test("dismissing the note asks the workspace and it stays gone after a reload", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await seedNote(student.workspaceId, ["htop"]);
	await page.goto(workspacePath(student.workspaceId));
	const notice = page.getByTestId("reinstall-notice");
	await expect(notice).toBeVisible({ timeout: 15_000 });

	await notice.getByRole("button", { name: "Dismiss the reinstall notice" }).click();

	await expect(notice).toHaveCount(0);
	await expect(page.getByRole("main", { name: "Work area" })).toBeFocused();
	expect(await agentNote(student.workspaceId)).toEqual([]);
	await page.reload();
	await expect(page.getByTestId("workspace-state")).toHaveText("Running", {
		timeout: 15_000,
	});
	await expect(page.getByTestId("reinstall-notice")).toHaveCount(0);
});

test("with nothing removed there is no note", async ({ page, context }) => {
	const student = await createStudent(context);
	await page.goto(workspacePath(student.workspaceId));
	await expect(page.getByTestId("workspace-state")).toHaveText("Running", {
		timeout: 15_000,
	});
	await expect(page.getByTestId("reinstall-notice")).toHaveCount(0);
});
