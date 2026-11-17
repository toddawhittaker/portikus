import { randomUUID } from "node:crypto";
import { type Browser, expect, test } from "@playwright/test";
import {
	createStudent,
	lockSharedState,
	loginAs,
	openToggletip,
	query,
	settledAxe,
	WCAG_TAGS,
} from "./helpers";
import { expectUsageColumnsAligned } from "./usage-tables";

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
	await query(
		`insert into ai_usage_days
		   (day, user_id, purpose, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
		 values (current_date, $1, 'assistant', 'e2e-model', 4321, 1234, 600, 400)`,
		[student.userId],
	);
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
	await expect(codex.getByRole("cell").nth(5)).toHaveText("—");
	await expect(page.getByTestId("agent-usage-daily")).toBeVisible();
	await expectUsageColumnsAligned(page);

	// The 20-day-old row appears only once the period grows.
	await page.getByRole("combobox", { name: "Period" }).click();
	await page.getByRole("option", { name: "Last 30 days" }).click();
	await expect(claude).toContainText("$5.75");

	await people.getByRole("button", { name: "About Estimated API cost" }).click();
	await expect(openToggletip(page)).toContainText("not what a subscription pays");
});

test("the Built-in assistant section shows the month against the cap and each person's use", async ({
	page,
	browser,
}) => {
	const context = await browser.newContext();
	const student = await createStudent(context);
	await context.close();
	const name = `Assistant ${randomUUID().slice(0, 8)}`;
	await query("update users set display_name = $2 where id = $1", [
		student.userId,
		name,
	]);
	const model = `e2e-model-${randomUUID().slice(0, 8)}`;
	await query(
		`insert into ai_usage_days
		   (day, user_id, purpose, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
		 values (current_date, $1, 'assistant', $2, 4321, 1234, 600, 400)`,
		[student.userId, model],
	);

	await loginAs(page, "carol");
	await page.goto("/admin/agents");
	const section = page.getByTestId("ai-usage");
	await expect(
		section.getByRole("heading", { name: "Built-in assistant" }),
	).toBeVisible();
	await expect(section.getByRole("meter", { name: "Used this month" })).toBeVisible();
	const row = section.getByRole("row", { name: new RegExp(`${name} Assistant`) });
	await expect(row).toContainText(model);
	await expect(row).toContainText("4,321");
	await expect(row).toContainText("1,234");
	await expect(row).toContainText("1,000");
	await expect(section).not.toContainText("Estimated input cost");
	// No price row names this model, so its estimate is a dash.
	await expect(row.getByRole("cell").last()).toHaveText("—");
});

/** The price table is the AI settings specs' shared state, so this one waits its turn. */
const AI_SETTINGS_LOCK = "e2e-ai-settings";

test("the Built-in assistant section estimates dollars from the price table and says what it left out", async ({
	page,
	browser,
}) => {
	const release = await lockSharedState(AI_SETTINGS_LOCK);
	const priced = `e2e-priced-${randomUUID().slice(0, 8)}`;
	const unpriced = `e2e-unpriced-${randomUUID().slice(0, 8)}`;
	try {
		const context = await browser.newContext();
		const student = await createStudent(context);
		await context.close();
		const name = `Estimate ${randomUUID().slice(0, 8)}`;
		await query("update users set display_name = $2 where id = $1", [
			student.userId,
			name,
		]);
		await query(
			`insert into model_prices
			   (provider, model, input_price_per_million, output_price_per_million,
			    cache_read_ratio, cache_write_ratio, cache_ttl_seconds, source_url, source_quote)
			 values ('openai', $1, 2, 10, 0.1, 1.25, 300, 'https://openai.com/api/pricing', 'e2e')`,
			[priced],
		);
		await query(
			`insert into ai_usage_days
			   (day, user_id, purpose, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
			 values (current_date, $1, 'assistant', $2, 1000000, 100000, 400000, 100000),
			        (current_date, $1, 'assistant', $3, 5000, 500, 0, 0)`,
			[student.userId, priced, unpriced],
		);
		await page.emulateMedia({ colorScheme: "dark" });
		await loginAs(page, "carol");
		await page.goto("/admin/agents");
		const section = page.getByTestId("ai-usage");
		const row = section.getByRole("row", {
			name: new RegExp(`${name} Assistant ${priced}`),
		});
		// 500k new input at $2, 400k cache reads at $0.20, 100k cache writes at $2.50, 100k output at $10.
		await expect(row.getByRole("cell").last()).toHaveText("$2.33");
		const other = section.getByRole("row", {
			name: new RegExp(`${name} Assistant ${unpriced}`),
		});
		await expect(other.getByRole("cell").last()).toHaveText("—");
		await expect(section.getByTestId("ai-usage-estimate")).toContainText(
			"Rows with a dash are not included",
		);
		await section.getByRole("button", { name: "About Estimate" }).click();
		await expect(openToggletip(page)).toContainText("A rough figure, not an invoice");
		const results = await (await settledAxe(page)).withTags(WCAG_TAGS).analyze();
		expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
	} finally {
		await query("delete from model_prices where model = $1", [priced]);
		await release();
	}
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
		await expect(page.getByTestId("ai-usage-users")).toBeVisible();
		const results = await (await settledAxe(page)).withTags(WCAG_TAGS).analyze();
		expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
	});
}
