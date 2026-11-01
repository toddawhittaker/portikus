import { expect, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	expectConnected,
	newTerminal,
	terminalIds,
	toast,
	workspacePath,
	workTabs,
} from "./helpers";
import { FAKE_AGENT_URL } from "./ports";

/**
 * F8 reaches an agent toast from a focused terminal (SPEC.md §25.8). xterm
 * would turn F8 into an escape sequence and cancel the event, so the terminal
 * hands a bare F8 back to the page.
 */
test.describe.configure({ timeout: 90_000 });

test("F8 from a focused terminal reaches the toast and Open project navigates", async ({
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

	await page.getByRole("link", { name: "Here" }).click();
	await expect(page).toHaveURL(new RegExp(`/projects/${here.id}$`));
	await newTerminal(page);
	await expect
		.poll(async () => (await terminalIds(student.workspaceId, here.id)).length)
		.toBe(1);
	const [shell] = await terminalIds(student.workspaceId, here.id);
	if (!shell) throw new Error("the terminal row was not created");
	await expectConnected(page, shell);

	const response = await fetch(`${FAKE_AGENT_URL}/__test/coding-agents`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			key: student.workspaceId,
			terminals: [{ terminalId: agent, agent: "claude", state: "needs-input" }],
		}),
	});
	expect(response.ok).toBe(true);
	const message = toast(page, "Claude Code needs your input");
	await expect(message).toBeVisible();

	await page.getByTestId(`terminal-pane-${shell}`).click();
	await page.keyboard.press("F8");
	// The first Tab lands on the toast itself, the second on its action.
	await page.keyboard.press("Tab");
	await page.keyboard.press("Tab");
	await expect(message.getByRole("button", { name: "Open project" })).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(page).toHaveURL(new RegExp(`/projects/${other.id}$`));
});
