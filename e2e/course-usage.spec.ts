/**
 * The Course page's Agent usage section (SPEC.md section 25.10): totals for
 * the course's members, seeded straight into agent_usage_days. Sam in CS 240
 * is the member; nothing else seeds usage for him.
 */
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { openToggletip, query, WEB_ORIGIN } from "./helpers";
import { changeRoster, launchAs, ltiUsers, openCourseTab } from "./lti-helpers";

test("an instructor sees member usage per agent, daily totals and a period choice", async ({
	browser,
	request,
}) => {
	// Tom teaches CS 240; a sync drops him unless the mock roster lists him.
	await changeRoster(request, { action: "add", course: "cs240", person: "tom" });
	const samContext = await browser.newContext({ baseURL: WEB_ORIGIN });
	await launchAs(await samContext.newPage(), { person: "sam", course: "cs240" });
	await samContext.close();
	const [sam] = await ltiUsers("sam");
	if (!sam) throw new Error("sam has no account");

	const boot = randomUUID();
	const insert = (agent: string, model: string, cost: number | null, ago: number) =>
		query(
			`insert into agent_usage_days
			   (user_id, boot_id, day, agent, model, sessions, input_tokens, output_tokens,
			    cache_read_tokens, cache_write_tokens, cost_usd, lines_added, lines_removed)
			 values ($1, $2, current_date - $6::int, $3, $4, 2, 1200, 3400, 5600, 780, $5, 90, 12)`,
			[sam.id, boot, agent, model, cost, ago],
		);
	await insert("claude", "opus", 4.5, 1);
	await insert("codex", "gpt", null, 1);
	// Outside 7 days but inside 30.
	await insert("claude", "opus-old", 1.25, 20);

	const tomContext = await browser.newContext({ baseURL: WEB_ORIGIN });
	try {
		const tom = await tomContext.newPage();
		await launchAs(tom, { person: "tom", course: "cs240" });
		const course = await openCourseTab(tom);

		await expect(
			course.getByRole("heading", { level: 2, name: "Agent usage", exact: true }),
		).toBeVisible();
		await expect(course.getByText(/never include prompts or code/)).toBeVisible();

		const people = course.getByTestId("agent-usage-users");
		const claude = people.getByRole("row", { name: /Sam Student Claude Code/ });
		await expect(claude).toContainText("$4.50");
		await expect(claude).toContainText("1,200");
		const codex = people.getByRole("row", { name: /Sam Student Codex/ });
		await expect(codex.getByRole("cell").nth(6)).toHaveText("—");
		await expect(course.getByTestId("agent-usage-daily")).toBeVisible();

		await course.getByRole("combobox", { name: "Period" }).click();
		await course.getByRole("option", { name: "Last 30 days" }).click();
		await expect(claude).toContainText("$5.75");

		await people.getByRole("button", { name: "About Estimated API cost" }).click();
		await expect(openToggletip(course)).toContainText("not what a subscription pays");
	} finally {
		await tomContext.close();
	}
});
