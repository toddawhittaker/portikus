import { randomUUID } from "node:crypto";
import { type Browser, expect, test } from "@playwright/test";
import {
	createStudent,
	loginAs,
	openToggletip,
	query,
	settledAxe,
	WCAG_TAGS,
} from "./helpers";

/**
 * The Agent usage tab (SPEC.md sections 20.1 and 25.10): everyone's totals
 * for a Claude Code row and a Codex row, seeded straight into
 * agent_usage_days. The person has a made-up name so other tests' rows
 * never match.
 */
async function seedUsage(browser: Browser) {
	// Its own context, so the student's session cookie stays out of the admin's page.
	const context = await browser.newContext();
	const student = await createStudent(context);
	await context.close();
	const name = `Usage ${randomUUID().slice(0, 8)}`;
	await query("update users set display_name = $2 where id = $1", [
		student.userId,
		name,
	]);
	const boot = randomUUID();
	const insert = (agent: string, model: string, cost: number | null, day: string) =>
		query(
			`insert into agent_usage_days
			   (user_id, boot_id, day, agent, model, sessions, input_tokens, output_tokens,
			    cache_read_tokens, cache_write_tokens, cost_usd, lines_added, lines_removed)
			 values ($1, $2, current_date - $6::int, $3, $4, 2, 1200, 3400, 5600, 780, $5, 90, 12)`,
			[student.userId, boot, agent, model, cost, day],
		);
	await insert("claude", "opus", 4.5, "1");
	await insert("codex", "gpt", null, "1");
	// Outside 7 days but inside 30.
	await insert("claude", "opus-old", 1.25, "20");
	return name;
}

test("the Agent usage tab lists each person and agent, with a period choice", async ({
	page,
	browser,
}) => {
	const name = await seedUsage(browser);
	await loginAs(page, "carol");
	await page.goto("/admin/agents");

	await expect(page).toHaveTitle(/Agent usage, Administration/);
	await expect(
		page.getByRole("heading", { level: 2, name: "Agent usage", exact: true }),
	).toBeVisible();
	await expect(page.getByTestId("intro-admin-agents")).toContainText(
		"never include prompts or code",
	);

	const people = page.getByTestId("agent-usage-users");
	const claude = people.getByRole("row", { name: new RegExp(`${name} Claude Code`) });
	await expect(claude).toContainText("$4.50");
	await expect(claude).toContainText("1,200");
	const codex = people.getByRole("row", { name: new RegExp(`${name} Codex`) });
	await expect(codex.getByRole("cell").nth(6)).toHaveText("—");
	await expect(page.getByTestId("agent-usage-daily")).toBeVisible();

	// The 20-day-old row appears only once the period grows.
	await page.getByRole("combobox", { name: "Period" }).click();
	await page.getByRole("option", { name: "Last 30 days" }).click();
	await expect(claude).toContainText("$5.75");

	await people.getByRole("button", { name: "About Estimated API cost" }).click();
	await expect(openToggletip(page)).toContainText("not what a subscription pays");
});

for (const colorScheme of ["light", "dark"] as const) {
	test(`the Agent usage tab has no automatic accessibility violations (${colorScheme})`, async ({
		page,
		browser,
	}) => {
		await seedUsage(browser);
		await page.emulateMedia({ colorScheme });
		await loginAs(page, "carol");
		await page.goto("/admin/agents");
		await expect(page.getByTestId("agent-usage-users")).toBeVisible();
		const results = await (await settledAxe(page)).withTags(WCAG_TAGS).analyze();
		expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
	});
}
