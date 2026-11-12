import { expect, type Locator, type Page, test } from "@playwright/test";
import { type Frame, makeChatTab, scriptChat } from "./chat-helpers";
import { addSession, expectNoViolations, workspacePath } from "./helpers";

/**
 * A permission card the student answered leaves a quiet line at its tool
 * call, which a second browser and a reload show too, because the host sends
 * the decision with `card.resolved` and replays it on attach (SPEC.md §10.8,
 * §25.8). The fake agent's chat stands in for the host; a scripted socket
 * covers the plan wording and the look.
 */

async function openFakeChat(page: Page, path: string, id: string) {
	await page.goto(path);
	const view = page.getByTestId(`chat-view-${id}`);
	await expect(view).toBeVisible({ timeout: 15_000 });
	// A send before the socket opens is refused; the picker is drawn from the host's settings.
	await expect(view.getByTestId("composer-model")).toBeAttached({ timeout: 15_000 });
	return view;
}

/** The fake's turn ends with its question card, then its permission card for `npm test`. */
async function reachPermissionCard(view: Locator) {
	const box = view.getByTestId("chat-composer-input");
	await box.fill("Look at the project");
	await box.press("Enter");
	await view.getByRole("button", { name: "Skip all" }).click();
	await expect(view.getByTestId("chat-permission-card")).toBeVisible();
}

/** The decision lines, read from the turn's opened "Worked for" fold. */
async function decisionLines(view: Locator): Promise<Locator> {
	const worked = view.getByTestId("chat-worked");
	if (!(await worked.evaluate((node) => (node as HTMLDetailsElement).open))) {
		await worked.locator("> summary").click();
	}
	return worked.getByTestId("chat-decision");
}

test("Allow leaves a line that another browser and a reload show too", async ({
	page,
	context,
	browser,
}) => {
	test.setTimeout(90_000);
	const { student, project, id } = await makeChatTab(page, context);
	const path = workspacePath(student.workspaceId, project.id);
	const view = await openFakeChat(page, path, id);
	const otherContext = await browser.newContext();
	try {
		await addSession(otherContext, student.userId);
		const other = await otherContext.newPage();
		const second = await openFakeChat(other, path, id);
		await reachPermissionCard(view);
		await expect(second.getByTestId("chat-permission-card")).toBeVisible();
		await view.getByRole("button", { name: "Allow once", exact: true }).click();
		await expect(view.getByTestId("chat-permission-card")).toHaveCount(0);

		await expect(await decisionLines(view)).toHaveText(["Allowed: npm test"]);
		await expect(await decisionLines(second)).toHaveText(["Allowed: npm test"]);

		// The host replays the decision after the history on attach.
		await page.reload();
		await expect(view).toBeVisible({ timeout: 15_000 });
		await expect(view.getByTestId("chat-worked")).toBeVisible();
		await expect(await decisionLines(view)).toHaveText(["Allowed: npm test"]);
		// It sits straight after the tool row it records, inside the fold.
		const row = view.getByTestId("chat-tool-card-permission").locator("xpath=..");
		await expect(row.locator("xpath=following-sibling::li[1]")).toHaveText(
			"Allowed: npm test",
		);
	} finally {
		await otherContext.close();
	}
});

test("Deny leaves a Denied line without the reason, and /clear removes it", async ({
	page,
	context,
}) => {
	test.setTimeout(90_000);
	const { student, project, id } = await makeChatTab(page, context);
	const view = await openFakeChat(
		page,
		workspacePath(student.workspaceId, project.id),
		id,
	);
	await reachPermissionCard(view);
	await view.getByRole("button", { name: "Deny" }).click();
	const reason = view.getByLabel("Tell Claude what to do instead");
	await reason.fill("Use pnpm instead");
	await reason.press("Enter");
	await expect(view.getByTestId("chat-permission-card")).toHaveCount(0);
	await expect(await decisionLines(view)).toHaveText(["Denied: npm test"]);
	await expect(view.getByText("Use pnpm instead")).toHaveCount(0);

	const box = view.getByTestId("chat-composer-input");
	await box.fill("/clear");
	await box.press("Enter");
	await expect(view.getByTestId("chat-decision")).toHaveCount(0);
	await page.reload();
	await expect(view).toBeVisible({ timeout: 15_000 });
	await expect(view.getByTestId("composer-model")).toBeAttached({ timeout: 15_000 });
	await expect(view.getByTestId("chat-decision")).toHaveCount(0);
});

test("Always allow says Allowed for this chat", async ({ page, context }) => {
	test.setTimeout(90_000);
	const { student, project, id } = await makeChatTab(page, context);
	const view = await openFakeChat(
		page,
		workspacePath(student.workspaceId, project.id),
		id,
	);
	await reachPermissionCard(view);
	await view.getByRole("button", { name: /^Always allow/ }).click();
	await expect(await decisionLines(view)).toHaveText([
		"Allowed for this chat: npm test",
	]);
});

const AT = Date.now() - 223_000;

/** A finished turn with one call of each kind of answer, as the host replays it. */
const DECIDED_TURN: Frame[] = [
	["message", { id: "u1", role: "user", markdown: "Tidy the dashboard and test it" }],
	["turn.started", { at: AT }],
	["message", { id: "a1", role: "assistant", markdown: "Here is my plan." }],
	[
		"tool.started",
		{
			id: "plan",
			name: "ExitPlanMode",
			title: "ExitPlanMode",
			input: { plan: "1. Split the query hook\n2. Run the tests" },
		},
	],
	["tool.finished", { id: "plan", isError: false }],
	[
		"tool.started",
		{
			id: "edit",
			name: "Edit",
			title: "Edit",
			input: {
				file_path: "/home/student/projects/dashboard/src/useDashboardQuery.ts",
				old_string: "a",
				new_string: "b",
			},
		},
	],
	["tool.finished", { id: "edit", isError: false }],
	[
		"tool.started",
		{ id: "test", name: "Bash", title: "Bash", input: { command: "pnpm test" } },
	],
	["tool.finished", { id: "test", isError: false }],
	[
		"tool.started",
		{ id: "rm", name: "Bash", title: "Bash", input: { command: "rm -rf build" } },
	],
	["tool.finished", { id: "rm", isError: true }],
	[
		"tool.started",
		{
			id: "replan",
			name: "ExitPlanMode",
			title: "ExitPlanMode",
			input: { plan: "1. Delete the build folder" },
		},
	],
	["tool.finished", { id: "replan", isError: false }],
	["message", { id: "a2", role: "assistant", markdown: "Done; the tests pass." }],
	["turn.finished", { at: AT + 223_000, status: "done" }],
	["card.resolved", { id: "plan", decision: "allowed" }],
	["card.resolved", { id: "edit", decision: "allowedAlways" }],
	["card.resolved", { id: "test", decision: "allowed" }],
	["card.resolved", { id: "rm", decision: "denied" }],
	["card.resolved", { id: "replan", decision: "denied" }],
];

for (const colorScheme of ["dark", "light"] as const) {
	test(`each kind of decision reads in words, in order, and passes axe (${colorScheme})`, async ({
		page,
		context,
	}) => {
		test.setTimeout(60_000);
		await page.emulateMedia({ colorScheme });
		const { id } = await makeChatTab(page, context);
		const view = await scriptChat(page, id, { first: DECIDED_TURN });
		await expect(await decisionLines(view)).toHaveText([
			"Plan approved",
			"Allowed for this chat: useDashboardQuery.ts",
			"Allowed: pnpm test",
			"Denied: rm -rf build",
			"Kept planning",
		]);
		await expectNoViolations(page, `[data-testid="chat-view-${id}"]`);
	});
}
