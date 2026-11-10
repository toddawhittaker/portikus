import { expect, test } from "@playwright/test";
import { makeChatTab, scriptedChat } from "./chat-helpers";
import { expectNoViolations } from "./helpers";

/**
 * "Always allow" names what it allows and for how long, and the rules a
 * session holds are listed with a way to revoke each (SPEC.md §10.8,
 * §25.8). The chat socket is answered by a script in the test, standing in
 * for the host.
 */

const LABEL = 'Always allow "sed" commands in this session';
const RULE = { rule: "Bash(sed:*)", description: '"sed" commands in this session' };

for (const colorScheme of ["light", "dark"] as const) {
	test(`Always allow names its rule, and a session rule can be revoked (${colorScheme})`, async ({
		page,
		context,
	}) => {
		test.setTimeout(60_000);
		await page.emulateMedia({ colorScheme });
		const { id } = await makeChatTab(page, context);
		const received: unknown[] = [];
		await page.routeWebSocket(/\/chat$/, (ws) => {
			const send = scriptedChat(ws, id);
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

test("inside a permission card, number keys choose its options; typed in the message box they do not", async ({
	page,
	context,
}) => {
	test.setTimeout(60_000);
	const { id } = await makeChatTab(page, context);
	const received: unknown[] = [];
	await page.routeWebSocket(/\/chat$/, (ws) => {
		const send = scriptedChat(ws, id);
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
			if (message.type === "permission.answer") send("card.resolved", { id: "p1" });
		});
	});
	await page.reload();
	const view = page.getByTestId(`chat-view-${id}`);
	const card = view.getByTestId("chat-permission-card");
	await expect(card).toBeVisible({ timeout: 15_000 });
	const deny = card.getByRole("button", { name: "Deny", exact: true });
	await expect(deny).toHaveAttribute("aria-keyshortcuts", "3");
	await expect(deny).toHaveText("3Deny");

	// Keys typed in the message box are text, never an answer (SPEC.md §25.8).
	const box = view.getByTestId("chat-composer-input");
	await box.click();
	await box.pressSequentially("123");
	await box.press("Enter");
	await expect(card).toBeVisible();
	expect(
		received.filter((m) => (m as { type: string }).type === "permission.answer"),
	).toEqual([]);

	await card.getByRole("button", { name: "Allow once", exact: true }).focus();
	// 3 is Deny, which first asks what to do instead; Enter sends a plain denial.
	await page.keyboard.press("3");
	await expect(card.getByLabel("Tell Claude what to do instead")).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(card).toHaveCount(0);
	await expect
		.poll(() =>
			received.filter((m) => (m as { type: string }).type === "permission.answer"),
		)
		.toEqual([{ type: "permission.answer", id: "p1", optionId: "deny" }]);
});
