import { type Browser, expect, type Page, test } from "@playwright/test";
import { createStudent, expectNoViolations, loginAs, query } from "./helpers";

/**
 * The workspace agent's own recent warnings on the admin workspace panel
 * (SPEC.md 20.1, ADR 0060). The fake agent answers `GET /log` with two fixed
 * lines; the panel labels them as reported by the workspace.
 */

async function namedStudent(browser: Browser, state = "running"): Promise<string> {
	const context = await browser.newContext();
	const student = await createStudent(context, { state });
	await context.close();
	const name = `Agent log ${student.userId.slice(0, 8)}`;
	await query("update users set display_name = $2 where id = $1", [
		student.userId,
		name,
	]);
	return name;
}

async function openSection(page: Page, name: string) {
	await loginAs(page, "carol");
	await page.goto("/admin");
	await expect(page.getByTestId("admin-accounts")).toBeVisible({ timeout: 15_000 });
	await page.getByTestId("admin-filter-text").fill(name);
	await page.getByRole("button", { name: `Show details for ${name}` }).click();
	const section = page
		.getByRole("region", { name })
		.getByRole("region", { name: /Agent log, reported by the workspace/ });
	await expect(section).toBeVisible();
	return section;
}

test("an administrator reads the agent's warnings, labelled as the workspace's", async ({
	page,
	browser,
}) => {
	const name = await namedStudent(browser);
	const section = await openSection(page, name);
	await expect(section).toContainText("Press Read log");

	await section.getByRole("button", { name: "Read log" }).click();
	const lines = section.getByTestId("agent-log-lines").locator("li");
	await expect(lines).toHaveCount(2);
	await expect(lines.nth(0)).toContainText(
		"could not tidy the coding-agent instructions files",
	);
	await expect(lines.nth(0)).toContainText("warn");
	await expect(lines.nth(1)).toContainText("request failed");
	await expect(lines.nth(1)).toContainText("INTERNAL · 500 · 12 ms");

	await section.getByRole("button", { name: "About Agent log" }).click();
	await expect(
		page.locator(".pk-toggletip-content", {
			hasText: "owner can change what it reports",
		}),
	).toBeVisible();
});

test("a stopped workspace offers no read", async ({ page, browser }) => {
	const name = await namedStudent(browser, "stopped");
	const section = await openSection(page, name);
	await expect(section).toContainText("The workspace is not running.");
	await expect(section.getByRole("button", { name: "Read log" })).toHaveCount(0);
});

for (const scheme of ["light", "dark"] as const) {
	test(`the agent log has no automatic violations (${scheme})`, async ({
		page,
		browser,
	}) => {
		await page.emulateMedia({ colorScheme: scheme });
		await page.setViewportSize({ width: 1024, height: 768 });
		const name = await namedStudent(browser);
		const section = await openSection(page, name);
		await section.getByRole("button", { name: "Read log" }).click();
		await expect(section.getByTestId("agent-log-lines").locator("li")).toHaveCount(2);
		await expectNoViolations(page, '[data-testid="detail-agent-log"]');
	});
}
