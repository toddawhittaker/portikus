import { expect, test } from "@playwright/test";
import { createStudent, loginAs, WEB_ORIGIN } from "./helpers";

/**
 * The Logs table at the narrowest admin width (SPEC.md section 24.11): a
 * long route must not squeeze the Message column to one word a
 * line, and no column may be cut off.
 */
test.use({ viewport: { width: 1024, height: 800 } });

test("at 1024 px the message keeps a readable width and every column fits", async ({
	page,
	browser,
}) => {
	// A stopped workspace refuses a terminal, a refusal the API logs at info.
	const context = await browser.newContext({ baseURL: WEB_ORIGIN });
	const student = await createStudent(context, { state: "stopped" });
	const refused = await context.request.post(
		`/workspaces/${student.workspaceId}/terminals`,
		{ headers: { origin: WEB_ORIGIN }, data: {} },
	);
	expect(refused.status()).toBe(409);
	await context.close();

	await loginAs(page, "carol");
	await expect(async () => {
		await page.goto(
			`/admin?tab=logs&level=info&q=AGENT_UNAVAILABLE&user=${student.userId}`,
		);
		await expect(page.getByTestId("log-row").first()).toBeVisible({ timeout: 2_000 });
	}).toPass({ timeout: 20_000 });

	const row = page.getByTestId("log-row").first();
	await expect(row).toContainText("AGENT_UNAVAILABLE");
	const message = row.getByTestId("log-message");
	// 24ch of 13 px text is well over 150 px; one word a line would be far less.
	expect((await message.boundingBox())?.width ?? 0).toBeGreaterThan(150);
	// The route wraps only before a slash, so it is never a column of single letters.
	expect(
		(await row.getByTestId("log-route").boundingBox())?.width ?? 0,
	).toBeGreaterThan(60);

	const fits = await page.getByTestId("logs-table").evaluate((table) => {
		const wrap = table.parentElement;
		return wrap ? table.scrollWidth <= wrap.clientWidth : false;
	});
	expect(fits).toBe(true);
});
