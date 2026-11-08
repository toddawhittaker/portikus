import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	expectNoViolations,
	newTerminal,
	query,
	terminalIds,
	workspacePath,
	workTabs,
} from "./helpers";

/**
 * "Always allow" names what it allows and for how long, and the rules a
 * session holds are listed with a way to revoke each (SPEC.md §10.8,
 * §25.8). The chat socket is answered by a script in the test, standing in
 * for the host.
 */

const LABEL = 'Always allow "sed" commands in this session';
const RULE = { rule: "Bash(sed:*)", description: '"sed" commands in this session' };

async function makeChatTab(page: Page, context: BrowserContext) {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "Rules" });
	await page.goto(workspacePath(student.workspaceId, project.id));
	await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
	await newTerminal(page);
	await expect
		.poll(async () => (await terminalIds(student.workspaceId, project.id)).length)
		.toBe(1);
	const [id] = await terminalIds(student.workspaceId, project.id);
	if (!id) throw new Error("the terminal row was not created");
	await query(
		"update terminals set kind = 'chat', agent = 'claude', name = 'Claude Code' where id = $1",
		[id],
	);
	return id;
}

for (const colorScheme of ["light", "dark"] as const) {
	test(`Always allow names its rule, and a session rule can be revoked (${colorScheme})`, async ({
		page,
		context,
	}) => {
		test.setTimeout(60_000);
		await page.emulateMedia({ colorScheme });
		const id = await makeChatTab(page, context);
		const received: unknown[] = [];
		await page.routeWebSocket(/\/chat$/, (ws) => {
			let seq = 0;
			const send = (type: string, body: Record<string, unknown> = {}) =>
				ws.send(JSON.stringify({ type, sessionId: id, seq: seq++, ...body }));
			send("snapshot", {
				cards: [
					{
						type: "permission",
						id: "p1",
						toolName: "Bash",
						title: "sed -i 's/a/b/' notes.txt",
						input: { command: "sed -i 's/a/b/' notes.txt" },
						options: [
							{ id: "allow", label: "Allow once" },
							{ id: "always", label: LABEL },
							{ id: "deny", label: "Deny" },
						],
					},
				],
				turnRunning: true,
				truncated: false,
			});
			send("settings", {
				agent: "claude",
				model: "claude-haiku-4-5",
				effort: "high",
				mode: "default",
			});
			send("rules", { rules: [] });
			ws.onMessage((raw) => {
				const message = JSON.parse(String(raw));
				received.push(message);
				if (message.type === "permission.answer") {
					send("rules", { rules: [RULE] });
					send("card.resolved", { id: "p1" });
				}
				if (message.type === "rule.revoke") send("rules", { rules: [] });
			});
		});
		await page.reload();
		const view = page.getByTestId(`chat-view-${id}`);
		await expect(view.getByTestId("chat-permission-card")).toBeVisible({
			timeout: 15_000,
		});
		const rules = view.getByTestId("chat-session-rules");
		await expect(rules).toHaveCount(0);
		await expectNoViolations(page, '[data-testid="chat-permission-card"]');

		await view.getByRole("button", { name: LABEL }).click();
		await expect(view.getByTestId("chat-permission-card")).toHaveCount(0);
		await expect(rules).toBeVisible();
		await rules.getByText("Allowed without asking in this session: 1 rule").click();
		await expect(rules.getByTestId("chat-session-rule")).toContainText("Bash(sed:*)");
		await expectNoViolations(page, '[data-testid="chat-session-rules"]');

		await rules.getByRole("button", { name: `Revoke: ${RULE.description}` }).click();
		await expect(rules).toHaveCount(0);
		expect(received).toEqual([
			{ type: "permission.answer", id: "p1", optionId: "always" },
			{ type: "rule.revoke", rule: "Bash(sed:*)" },
		]);
	});
}
