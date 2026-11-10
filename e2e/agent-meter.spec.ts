/**
 * The status bar's provider usage (SPEC.md §10.8, §25.10): each provider's
 * 7-day plan usage with its reset day and time, today's counts only when
 * there is no plan, a details popover, and a saved warning toast once per
 * provider and reset time. Plan usage comes from the fake agent's hook;
 * counts are seeded into agent_usage_days.
 */
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import {
	createStudent,
	expectNoViolations,
	query,
	type TestStudent,
	workspacePath,
} from "./helpers";
import { FAKE_AGENT_URL } from "./ports";

type Plan = { id: string; label: string; usedPercent: number; resetsAt: string };
const inHours = (hours: number) =>
	new Date(Date.now() + hours * 3_600_000).toISOString();
const claude = (usedPercent: number, resetsAt = inHours(70)): Plan => ({
	id: "claude",
	label: "Claude",
	usedPercent,
	resetsAt,
});
const codex = (usedPercent: number, resetsAt = inHours(70)): Plan => ({
	id: "codex",
	label: "Codex",
	usedPercent,
	resetsAt,
});

async function setPlans(workspaceId: string, providers: Plan[]) {
	const response = await fetch(`${FAKE_AGENT_URL}/__test/agent-limits`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ key: workspaceId, providers }),
	});
	expect(response.ok).toBe(true);
}

async function seedToday(userId: string, agent: string, cost: number | null) {
	await query(
		`insert into agent_usage_days
		   (user_id, boot_id, day, agent, model, sessions, input_tokens, output_tokens,
		    cache_read_tokens, cache_write_tokens, cost_usd, lines_added, lines_removed)
		 values ($1, $2, (now() at time zone 'utc')::date, $3, 'model-a', 3, 800000, 400000,
		         1000, 234, $4, 0, 0)`,
		[userId, randomUUID(), agent, cost],
	);
}

async function reopen(page: Page, student: TestStudent) {
	await page.goto(workspacePath(student.workspaceId));
	await expect(page.getByTestId("workspace-state")).toHaveText("Running");
}

test("a plan shows its percent and reset, and the details open by keyboard", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await setPlans(student.workspaceId, [claude(42.6)]);
	await page.goto(workspacePath(student.workspaceId));
	const meter = page.getByTestId("agent-meter-claude");
	await expect(meter).toHaveText(/^Claude42%resets .+/);
	await expect(meter).toHaveAttribute("data-level", "ok");
	await expect(meter).toHaveAccessibleName(
		/^Claude 42% of the 7-day limit, resets .+\. Show usage details$/,
	);
	await expect(page.getByTestId("agent-meter-codex")).toHaveCount(0);

	const details = page.getByTestId("agent-meter-claude-details");
	await expect(details).toBeHidden();
	await meter.focus();
	await page.keyboard.press("Enter");
	await expect(details).toBeVisible();
	await expect(details).toContainText("Limit7 days");
	await expect(details).toContainText("Used42%");
	await expect(details).toContainText("Resets");
	await page.keyboard.press("Escape");
	await expect(details).toBeHidden();
	await expect(meter).toBeFocused();
});

test("each provider that reports a plan gets its own entry", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await setPlans(student.workspaceId, [claude(41), codex(63)]);
	await page.goto(workspacePath(student.workspaceId));
	await expect(page.getByTestId("agent-meter-claude")).toHaveText(/^Claude41%resets /);
	await expect(page.getByTestId("agent-meter-codex")).toHaveText(/^Codex63%resets /);
});

test("with a plan, tokens and cost stay out of the status bar", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await seedToday(student.userId, "claude", 3.4);
	await setPlans(student.workspaceId, [claude(30)]);
	await page.goto(workspacePath(student.workspaceId));
	const meter = page.getByTestId("agent-meter-claude");
	await expect(meter).toHaveAttribute("data-kind", "plan");
	await expect(meter).not.toContainText("tokens");
	await expect(page.getByTestId("agent-meter-claude-details")).not.toContainText(
		"Estimated cost",
	);
});

test("usage past the warning share turns the meter to the warning tone", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await setPlans(student.workspaceId, [codex(88)]);
	await page.goto(workspacePath(student.workspaceId));
	const meter = page.getByTestId("agent-meter-codex");
	await expect(meter).toHaveAttribute("data-level", "warning");
	await expect(meter).toHaveAccessibleName(/nearly full/);
});

test("with no plan, today's counts show tokens and cost, and the details list them", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await seedToday(student.userId, "claude", 3.4);
	await seedToday(student.userId, "codex", null);
	await page.goto(workspacePath(student.workspaceId));
	await expect(page.getByTestId("agent-meter-claude")).toHaveText(
		"Claude today: 1.2M tokens · ≈$3.40",
	);
	// Codex reports no cost, so it shows tokens only.
	await expect(page.getByTestId("agent-meter-codex")).toHaveText(
		"Codex today: 1.2M tokens",
	);

	await page.getByTestId("agent-meter-claude").focus();
	await page.keyboard.press("Enter");
	const details = page.getByTestId("agent-meter-claude-details");
	await expect(details).toBeVisible();
	await expect(details).toContainText("Sessions today3");
	await expect(details).toContainText("Input tokens800,000");
	await expect(details).toContainText("Output tokens400,000");
	await expect(details).toContainText("Cache tokens1,234");
	await expect(details).toContainText("Estimated cost≈$3.40");
	await expect(details).toContainText(
		"Counts update every 5 minutes. Days start at midnight UTC.",
	);
	// Tab from the button reaches nothing inside: the details are text only.
	await expect(page.getByTestId("agent-meter-codex-details")).toBeHidden();
});

test("a provider with no plan and no counts is not shown", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	// Registered before the page loads, so a fast first poll is not missed.
	const answered = page.waitForResponse((r) => r.url().includes("/agent-meter"));
	await page.goto(workspacePath(student.workspaceId));
	await answered;
	await expect(page.getByTestId("workspace-state")).toHaveText("Running");
	await expect(page.getByTestId("agent-meter-claude")).toHaveCount(0);
	await expect(page.getByTestId("agent-meter-codex")).toHaveCount(0);
});

test("a plan past its reset is hidden, and today's counts show in its place", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await seedToday(student.userId, "claude", 3.4);
	// The contract allows a reset in the past; the page must not trust it.
	await setPlans(student.workspaceId, [claude(99, inHours(-1))]);
	await page.goto(workspacePath(student.workspaceId));
	const meter = page.getByTestId("agent-meter-claude");
	await expect(meter).toHaveAttribute("data-kind", "today");
	await expect(meter).toHaveText("Claude today: 1.2M tokens · ≈$3.40");
});

test("crossing the warning share shows one saved warning, not again on reload", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await setPlans(student.workspaceId, [claude(91)]);
	await page.goto(workspacePath(student.workspaceId));
	const toast = page.getByRole("alert").filter({ hasText: "Claude usage is at 91%" });
	await expect(toast).toBeVisible();
	await expect(toast).toContainText("The 7-day limit resets");

	await reopen(page, student);
	await expect(page.getByTestId("agent-meter-claude")).toHaveAttribute(
		"data-level",
		"warning",
	);
	await expect(toast).toHaveCount(0);

	// The warning went into the notification history.
	await expect
		.poll(
			async () =>
				(
					await query(
						"select 1 from notifications where user_id = $1 and tone = 'warning' and title = 'Claude usage is at 91%'",
						[student.userId],
					)
				).length,
		)
		.toBe(1);
});

for (const scheme of ["light", "dark"] as const) {
	test(`the meters pass axe, and fit a narrow bar (${scheme})`, async ({
		page,
		context,
	}) => {
		await page.emulateMedia({ colorScheme: scheme });
		const student = await createStudent(context);
		await setPlans(student.workspaceId, [claude(90)]);
		await seedToday(student.userId, "codex", null);
		await page.goto(workspacePath(student.workspaceId));
		await expect(page.getByTestId("agent-meter-claude")).toBeVisible();
		await expect(page.getByTestId("agent-meter-codex")).toBeVisible();
		await page.getByTestId("agent-meter-claude").click();
		const bar = page.getByTestId("status-bar");
		await bar.screenshot({ path: `screenshots/agent-meter-wide-${scheme}.png` });
		await page.screenshot({ path: `screenshots/agent-meter-popover-${scheme}.png` });
		await expectNoViolations(page);
		await page.keyboard.press("Escape");

		await bar.evaluate((node) => {
			node.style.width = "360px";
		});
		const outside = await bar.evaluate((node) => {
			const box = node.getBoundingClientRect();
			return {
				scrolls: node.scrollWidth > node.clientWidth,
				outside: [...node.querySelectorAll<HTMLElement>("button")]
					.filter((button) => {
						const rect = button.getBoundingClientRect();
						return rect.left < box.left - 0.5 || rect.right > box.right + 0.5;
					})
					.map((button) => button.dataset.testid),
			};
		});
		expect(outside).toEqual({ scrolls: false, outside: [] });
		await bar.screenshot({ path: `screenshots/agent-meter-360-${scheme}.png` });
		await expectNoViolations(page, '[data-testid="status-bar"]');
	});
}
