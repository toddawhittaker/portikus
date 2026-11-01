import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	expectConnected,
	expectNoViolations,
	terminalIds,
	toast,
	WEB_ORIGIN,
	workspacePath,
	workTabs,
} from "./helpers";
import { FAKE_AGENT_URL } from "./ports";

/**
 * Agent status in tabs, the project list and toasts (SPEC.md §8.5, §25.8).
 * The fake agent stands in for the hooks: each post replaces the whole list.
 */

type AgentState = "working" | "needs-input" | "finished";

async function setAgents(
	workspaceId: string,
	terminals: { terminalId: string; agent: "claude" | "codex"; state: AgentState }[],
): Promise<void> {
	const response = await fetch(`${FAKE_AGENT_URL}/__test/coding-agents`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ key: workspaceId, terminals }),
	});
	if (!response.ok)
		throw new Error(`the fake agent refused the states: ${response.status}`);
}

/** Open Claude Code, then a plain terminal, so the shell is the tab on screen. */
async function openAgentAndShell(page: Page, workspaceId: string, projectId: string) {
	await page.getByTestId("launcher").click();
	await page.getByTestId("launcher-claude").click();
	await expect
		.poll(async () => (await terminalIds(workspaceId, projectId)).length)
		.toBe(1);
	await page.getByTestId("launcher").click();
	await page.getByTestId("launcher-terminal").click();
	await expect
		.poll(async () => (await terminalIds(workspaceId, projectId)).length)
		.toBe(2);
	const [agent, shell] = await terminalIds(workspaceId, projectId);
	if (!agent || !shell) throw new Error("the terminal rows were not created");
	await expectConnected(page, shell);
	return { agent, shell };
}

for (const colorScheme of ["light", "dark"] as const) {
	test.describe(`agent status (${colorScheme})`, () => {
		test.describe.configure({ timeout: 90_000 });

		test.beforeEach(async ({ page }) => {
			await page.emulateMedia({ colorScheme });
		});

		test("a tab shows what its agent is doing and clears the unread mark when viewed", async ({
			page,
			context,
		}) => {
			const student = await createStudent(context);
			const project = await createProject(student.workspaceId, { name: "Tab marks" });
			await page.goto(workspacePath(student.workspaceId, project.id));
			await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
			const { agent } = await openAgentAndShell(page, student.workspaceId, project.id);
			const claude = page.getByRole("tab", { name: /^Claude Code/ });
			const base = { terminalId: agent, agent: "claude" as const };

			await setAgents(student.workspaceId, [{ ...base, state: "working" }]);
			await expect(
				page.getByRole("tab", { name: "Claude Code (working)" }),
			).toBeVisible();
			await expect(toast(page, "Claude Code")).toHaveCount(0);

			// The shell is on screen, so the agent tab is out of sight.
			await setAgents(student.workspaceId, [{ ...base, state: "needs-input" }]);
			await expect(
				page.getByRole("tab", { name: "Claude Code (needs input)" }),
			).toBeVisible();
			await expect(toast(page, "Claude Code needs your input")).toBeVisible();

			await setAgents(student.workspaceId, [{ ...base, state: "finished" }]);
			await expect(
				page.getByRole("tab", { name: "Claude Code (finished, unread)" }),
			).toBeVisible();
			await expect(toast(page, "Claude Code finished")).toBeVisible();
			// The three states use three different glyphs.
			await expect(page.getByTestId(/^tab-.*-agent$/)).toHaveAttribute(
				"data-agent-state",
				"finished",
			);
			await expectNoViolations(page, '[data-testid="work-tabs"]', ".pk-toast");

			// Looking at the tab clears the mark and takes its toast away.
			await claude.click();
			await expect(
				page.getByRole("tab", { name: "Claude Code", exact: true }),
			).toBeVisible();
			await expect(page.getByTestId(/^tab-.*-agent$/)).toHaveCount(0);
			await expect(toast(page, "Claude Code finished")).toHaveCount(0);

			// A change in the tab being viewed raises no alert.
			await setAgents(student.workspaceId, [{ ...base, state: "needs-input" }]);
			await expect(
				page.getByRole("tab", { name: "Claude Code (needs input)" }),
			).toBeVisible();
			await expect(toast(page, "Claude Code needs your input")).toHaveCount(0);
		});

		test("states present at connection raise no alert", async ({ page, context }) => {
			const student = await createStudent(context);
			const project = await createProject(student.workspaceId, { name: "First list" });
			await page.goto(workspacePath(student.workspaceId, project.id));
			await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
			const { agent } = await openAgentAndShell(page, student.workspaceId, project.id);
			await setAgents(student.workspaceId, [
				{ terminalId: agent, agent: "claude", state: "needs-input" },
			]);
			await expect(
				page.getByRole("tab", { name: "Claude Code (needs input)" }),
			).toBeVisible();
			await expect(toast(page, "Claude Code needs your input")).toBeVisible();

			// A fresh page load is a first list: the state shows, no alert is raised.
			await page.reload();
			await expect(page.getByRole("tab", { name: /Claude Code/ })).toBeVisible({
				timeout: 15_000,
			});
			await expect(
				page.getByRole("tab", { name: "Claude Code (needs input)" }),
			).toBeVisible();
			await expect(page.locator(".pk-toast")).toHaveCount(0);
		});

		test("another project's agent shows in the project list and its toast opens it", async ({
			page,
			context,
		}) => {
			const student = await createStudent(context);
			const other = await createProject(student.workspaceId, { name: "Other work" });
			const here = await createProject(student.workspaceId, { name: "Here" });
			await page.goto(workspacePath(student.workspaceId, other.id));
			await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
			await page.getByTestId("launcher").click();
			await page.getByTestId("launcher-claude").click();
			await expect
				.poll(async () => (await terminalIds(student.workspaceId, other.id)).length)
				.toBe(1);
			const [agent] = await terminalIds(student.workspaceId, other.id);
			if (!agent) throw new Error("the terminal row was not created");
			await expect(page.getByRole("tab", { name: /Claude Code/ })).toBeVisible();

			await page.getByRole("link", { name: "Here" }).click();
			await expect(page).toHaveURL(new RegExp(`/projects/${here.id}$`));
			const row = page.getByTestId(`project-item-${other.id}`).getByRole("link");
			await expect(row).toHaveAccessibleName("Other work");

			await setAgents(student.workspaceId, [
				{ terminalId: agent, agent: "claude", state: "working" },
			]);
			await expect(row).toHaveAccessibleName("Other work (working)");
			await expect(toast(page, "Claude Code")).toHaveCount(0);

			await setAgents(student.workspaceId, [
				{ terminalId: agent, agent: "claude", state: "finished" },
			]);
			await expect(row).toHaveAccessibleName("Other work (finished, unread)");
			const message = toast(page, "Claude Code finished");
			await expect(message).toBeVisible();
			await expect(message).toContainText("In Other work");
			await expectNoViolations(page, '[data-testid="project-list"]', ".pk-toast");

			// The keyboard reaches the action.
			await message.getByRole("button", { name: "Open project" }).focus();
			await page.keyboard.press("Enter");
			await expect(page).toHaveURL(new RegExp(`/projects/${other.id}$`));
			await expect(page.getByRole("tab", { name: /Claude Code/ })).toBeVisible();
			// Showing the tab clears the mark, the toast and the row's badge.
			await expect(row).toHaveAccessibleName("Other work");
			await expect(toast(page, "Claude Code finished")).toHaveCount(0);
		});

		test("the most urgent state wins in the project list", async ({
			page,
			context,
		}) => {
			const student = await createStudent(context);
			const other = await createProject(student.workspaceId, { name: "Busy" });
			const here = await createProject(student.workspaceId, { name: "Calm" });
			await page.goto(workspacePath(student.workspaceId, other.id));
			await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
			for (const id of ["launcher-claude", "launcher-terminal"]) {
				await page.getByTestId("launcher").click();
				await page.getByTestId(id).click();
			}
			await expect
				.poll(async () => (await terminalIds(student.workspaceId, other.id)).length)
				.toBe(2);
			const [first, second] = await terminalIds(student.workspaceId, other.id);
			if (!first || !second) throw new Error("the terminal rows were not created");
			await page.goto(workspacePath(student.workspaceId, here.id));
			const row = page.getByTestId(`project-item-${other.id}`).getByRole("link");
			await expect(row).toBeVisible({ timeout: 15_000 });

			await setAgents(student.workspaceId, [
				{ terminalId: first, agent: "claude", state: "working" },
				{ terminalId: second, agent: "codex", state: "needs-input" },
			]);
			await expect(row).toHaveAccessibleName("Busy (needs input)");
			await setAgents(student.workspaceId, [
				{ terminalId: first, agent: "claude", state: "working" },
				{ terminalId: second, agent: "codex", state: "working" },
			]);
			await expect(row).toHaveAccessibleName("Busy (working)");
		});
	});
}

/** The setting the account has saved for desktop notifications. */
async function savedChoice(page: Page): Promise<string> {
	const response = await page.request.get("/me/settings");
	return ((await response.json()) as { agentNotifications: string }).agentNotifications;
}

/** A page with an agent tab out of sight, ready for an alert. */
async function readyForAlert(page: Page, context: BrowserContext) {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "Offer" });
	await page.goto(workspacePath(student.workspaceId, project.id));
	await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
	const { agent } = await openAgentAndShell(page, student.workspaceId, project.id);
	return { student, agent };
}

test.describe("the desktop notification offer", () => {
	test.describe.configure({ timeout: 90_000 });

	test("Turn on saves on, and later alert toasts time out on their own", async ({
		page,
		context,
	}) => {
		await context.grantPermissions(["notifications"], { origin: WEB_ORIGIN });
		// Headless Chromium reports "denied" for the property even when granted, so
		// show an undecided browser; the click's request is answered by the grant.
		await page.addInitScript(() => {
			Object.defineProperty(Notification, "permission", { get: () => "default" });
		});
		const { student, agent } = await readyForAlert(page, context);
		expect(await savedChoice(page)).toBe("ask");

		await setAgents(student.workspaceId, [
			{ terminalId: agent, agent: "claude", state: "needs-input" },
		]);
		const first = toast(page, "Claude Code needs your input");
		await expect(
			first.getByRole("button", { name: "Turn on desktop notifications" }),
		).toBeVisible();
		await expect(first.getByRole("button", { name: "No thanks" })).toBeVisible();
		await expectNoViolations(page, ".pk-toast");
		// It waits for an answer.
		await page.waitForTimeout(6000);
		await expect(first).toBeVisible();

		await first.getByRole("button", { name: "Turn on desktop notifications" }).click();
		await expect.poll(() => savedChoice(page)).toBe("on");

		await setAgents(student.workspaceId, [
			{ terminalId: agent, agent: "claude", state: "finished" },
		]);
		const second = toast(page, "Claude Code finished");
		await expect(second).toBeVisible();
		await expect(second.getByRole("button", { name: "Dismiss" })).toHaveCount(1);
		await expect(second.getByRole("button", { name: "No thanks" })).toHaveCount(0);
		await expect(second).toBeHidden({ timeout: 10_000 });
	});

	test("No thanks saves off in a browser that has not decided", async ({
		page,
		context,
	}) => {
		await page.addInitScript(() => {
			Object.defineProperty(Notification, "permission", { get: () => "default" });
		});
		const { student, agent } = await readyForAlert(page, context);
		await setAgents(student.workspaceId, [
			{ terminalId: agent, agent: "claude", state: "finished" },
		]);
		const first = toast(page, "Claude Code finished");
		await first.getByRole("button", { name: "No thanks" }).focus();
		await page.keyboard.press("Enter");
		await expect.poll(() => savedChoice(page)).toBe("off");
		await expect(first.getByRole("button", { name: "No thanks" })).toHaveCount(0);
	});

	test("an alert toast without the offer times out", async ({ page, context }) => {
		// Headless Chromium blocks notifications, so there is nothing to offer.
		const { student, agent } = await readyForAlert(page, context);
		await setAgents(student.workspaceId, [
			{ terminalId: agent, agent: "claude", state: "needs-input" },
		]);
		const message = toast(page, "Claude Code needs your input");
		await expect(message).toBeVisible();
		await expect(message.getByRole("button", { name: "No thanks" })).toHaveCount(0);
		await expect(message).toBeHidden({ timeout: 10_000 });
	});
});
