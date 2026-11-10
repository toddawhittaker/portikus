import { expect, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	expectNoViolations,
	terminalIds,
	workspacePath,
	workTabs,
} from "./helpers";
import { FAKE_AGENT_URL } from "./ports";

/**
 * The agent rows in the project list by keyboard and screen reader (SPEC.md
 * §8.2, §25.8): a list of links, not a tree; one disclosure per project; the
 * state in each link's name; nothing announced as it ticks.
 */

for (const colorScheme of ["light", "dark"] as const) {
	test(`agent rows are links in a list, reached and folded by keyboard (${colorScheme})`, async ({
		page,
		context,
	}) => {
		test.setTimeout(90_000);
		await page.emulateMedia({ colorScheme });
		const student = await createStudent(context);
		const project = await createProject(student.workspaceId, { name: "Keys" });
		await page.goto(workspacePath(student.workspaceId, project.id));
		await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
		await page.getByTestId("launcher").click();
		await page.getByTestId("launcher-claude").click();
		await expect
			.poll(async () => (await terminalIds(student.workspaceId, project.id)).length)
			.toBe(1);
		const [agent] = await terminalIds(student.workspaceId, project.id);
		const response = await fetch(`${FAKE_AGENT_URL}/__test/coding-agents`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				key: student.workspaceId,
				terminals: [
					{
						terminalId: agent,
						agent: "claude",
						state: "working",
						subagents: [
							{
								id: "toolu_plan",
								type: "Plan",
								description: "Plan the change",
								state: "working",
							},
						],
					},
				],
			}),
		});
		expect(response.ok).toBe(true);

		const list = page.getByRole("list", { name: "Agents in Keys" });
		await expect(list.getByRole("link")).toHaveCount(2);
		// Not a tree, and not a live region: the toasts announce changes.
		await expect(
			page.locator('[data-testid="project-list"] [role="tree"]'),
		).toHaveCount(0);
		await expect(page.locator('[data-testid="project-list"] [aria-live]')).toHaveCount(
			0,
		);
		await expect(list.getByRole("link").first()).toHaveAccessibleName(
			"Claude Code (TUI) Working",
		);
		await expect(list.getByRole("link").nth(1)).toHaveAccessibleName(
			"Plan the change Plan (working)",
		);
		await expectNoViolations(page, '[data-testid="project-list"]');

		// Project link, then its disclosure, its menu, then the agent rows in order.
		await page.getByTestId(`project-item-${project.id}`).getByRole("link").focus();
		await page.keyboard.press("Tab");
		const toggle = page.getByRole("button", { name: "Agents in Keys" });
		await expect(toggle).toBeFocused();
		await page.keyboard.press("Tab");
		await expect(page.getByTestId(`project-menu-${project.id}`)).toBeFocused();
		await page.keyboard.press("Tab");
		const agentRow = list.getByRole("link").first();
		await expect(agentRow).toBeFocused();
		// The focus ring is drawn, not removed.
		await expect(agentRow).toHaveCSS("outline-style", "solid");
		await page.keyboard.press("Tab");
		await expect(list.getByRole("link").nth(1)).toBeFocused();

		// Enter on a row selects its tab.
		await page.keyboard.press("Shift+Tab");
		await page.keyboard.press("Enter");
		await expect(
			page.getByRole("tab", { name: /^Claude Code \(TUI\)/ }),
		).toHaveAttribute("aria-selected", "true");

		// The disclosure works by keyboard and its rows leave the tab order.
		await toggle.focus();
		await page.keyboard.press("Enter");
		await expect(toggle).toHaveAttribute("aria-expanded", "false");
		await expect(list).toBeHidden();
		await page.keyboard.press("Tab");
		await page.keyboard.press("Tab");
		await expect(
			page.getByTestId(`project-agents-${project.id}`).locator(":focus"),
		).toHaveCount(0);
		await expectNoViolations(page, '[data-testid="project-list"]');
		await toggle.focus();
		await page.keyboard.press("Space");
		await expect(toggle).toHaveAttribute("aria-expanded", "true");
		await expect(list).toBeVisible();
	});
}
