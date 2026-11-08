import { expect, type Page, test } from "@playwright/test";
import { makeChatTab } from "./chat-helpers";
import {
	createProject,
	createStudent,
	expectNoViolations,
	newTerminal,
	seedFile,
	setAgents,
	terminalIds,
	toast,
	workspacePath,
	workTabs,
} from "./helpers";
import { png } from "./png";
import { splitPane } from "./split-helpers";

/**
 * The chat's smaller accessibility fixes (SPEC.md §8.5, §10.8, §25.8): a
 * revoked session rule hands the keyboard on and says so, an agent toast
 * never covers the composer's Send, the question pager says why an arrow is
 * unavailable, and code in a reply keeps image syntax as written.
 */

const SED = { rule: "Bash(sed:*)", description: '"sed" commands in this session' };
const GREP = { rule: "Bash(grep:*)", description: '"grep" commands in this session' };

/** A frame the scripted host sends: its type and body. */
type Frame = [string, object];

/**
 * The chat socket answered by a script standing in for the host: a snapshot
 * with `snapshot` merged in, the settings, then `first`, and whatever
 * `reply` sends for each message from the browser.
 */
async function scriptChat(
	page: Page,
	id: string,
	{
		snapshot = {},
		first = [],
		reply,
	}: {
		snapshot?: object;
		first?: Frame[];
		reply?: (
			message: { type: string; rule?: string },
			send: (frame: Frame) => void,
		) => void;
	},
) {
	await page.routeWebSocket(/\/chat$/, (ws) => {
		let seq = 0;
		const send = ([type, body]: Frame) =>
			ws.send(JSON.stringify({ type, sessionId: id, seq: seq++, ...body }));
		send([
			"snapshot",
			{ cards: [], turnRunning: false, truncated: false, ...snapshot },
		]);
		send([
			"settings",
			{ agent: "claude", model: "default", effort: "high", mode: "default" },
		]);
		for (const frame of first) send(frame);
		ws.onMessage((raw) => reply?.(JSON.parse(String(raw)), send));
	});
	await page.reload();
	const view = page.getByTestId(`chat-view-${id}`);
	await expect(view.getByTestId("composer-model")).toBeVisible({ timeout: 15_000 });
	return view;
}

/** Whether two boxes share any area. */
function overlap(
	a: { x: number; y: number; width: number; height: number },
	b: { x: number; y: number; width: number; height: number },
): boolean {
	return (
		a.x < b.x + b.width &&
		b.x < a.x + a.width &&
		a.y < b.y + b.height &&
		b.y < a.y + a.height
	);
}

for (const colorScheme of ["light", "dark"] as const) {
	test.describe(`chat review fixes (${colorScheme})`, () => {
		test.describe.configure({ timeout: 90_000 });

		test.beforeEach(async ({ page }) => {
			await page.emulateMedia({ colorScheme });
		});

		test("Revoke from the keyboard waits busy, then moves on and says what it revoked", async ({
			page,
			context,
		}) => {
			const { id } = await makeChatTab(page, context);
			const revoked: string[] = [];
			let held = [SED, GREP];
			// The first revoke waits until the test lets the host answer.
			let answer: (() => void) | null = null;
			const view = await scriptChat(page, id, {
				first: [["rules", { rules: held }]],
				reply: (message, send) => {
					if (message.type !== "rule.revoke") return;
					revoked.push(message.rule ?? "");
					held = held.filter((rule) => rule.rule !== message.rule);
					const confirm = () => send(["rules", { rules: held }]);
					if (revoked.length === 1) answer = confirm;
					else confirm();
				},
			});
			const rules = view.getByTestId("chat-session-rules");
			await rules.getByText("Allowed without asking in this session: 2 rules").focus();
			await page.keyboard.press("Enter");
			const sed = rules.getByRole("button", { name: `Revoke: ${SED.description}` });
			const grep = rules.getByRole("button", { name: `Revoke: ${GREP.description}` });
			await page.keyboard.press("Tab");
			await expect(sed).toBeFocused();
			await expectNoViolations(page, '[data-testid="chat-session-rules"]');

			await page.keyboard.press("Enter");
			await expect(sed).toHaveAttribute("aria-busy", "true");
			await expect(sed).toHaveAttribute("aria-disabled", "true");
			await page.keyboard.press("Enter");
			await expect.poll(() => answer !== null).toBe(true);
			expect(revoked).toEqual([SED.rule]);

			(answer as (() => void) | null)?.();
			await expect(sed).toHaveCount(0);
			await expect(grep).toBeFocused();
			const status = view.getByTestId("chat-session-rules-status");
			await expect(status).toHaveText(`Revoked: ${SED.description}.`);

			// The last rule takes the list with it, so the message box takes the keyboard.
			await page.keyboard.press("Enter");
			await expect(rules).toHaveCount(0);
			await expect(view.getByTestId("chat-composer-input")).toBeFocused();
			await expect(status).toHaveText(`Revoked: ${GREP.description}.`);
			expect(revoked).toEqual([SED.rule, GREP.rule]);
		});

		test("agent toasts never cover a focused control of a chat on the right", async ({
			page,
			context,
		}) => {
			const student = await createStudent(context);
			const project = await createProject(student.workspaceId, { name: "Toasts" });
			const ids = () => terminalIds(student.workspaceId, project.id);
			await page.goto(workspacePath(student.workspaceId, project.id));
			await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
			// Two Claude Code tabs, then a shell with a chat split to its right.
			for (const count of [1, 2]) {
				await page.getByTestId("launcher").click();
				await page.getByTestId("launcher-claude").click();
				await expect.poll(async () => (await ids()).length).toBe(count);
			}
			const agents = await ids();
			await newTerminal(page);
			await expect.poll(async () => (await ids()).length).toBe(3);
			const shell = (await ids()).find((one) => !agents.includes(one));
			if (!shell) throw new Error("the shell's row was not created");
			await splitPane(page, shell, "right", "claude-gui");
			await expect.poll(async () => (await ids()).length).toBe(4);
			const chat = (await ids()).find((one) => one !== shell && !agents.includes(one));
			const view = page.getByTestId(`chat-view-${chat}`);
			await expect(view.getByTestId("composer-model")).toBeVisible({ timeout: 15_000 });

			const report = (state: "working" | "needs-input") =>
				setAgents(
					student.workspaceId,
					agents.map((terminalId) => ({ terminalId, agent: "claude" as const, state })),
				);
			await report("working");
			await expect(page.getByRole("tab", { name: /\(working\)/ })).toHaveCount(2);
			await report("needs-input");
			const toasts = page.locator(".pk-toast");
			await expect(toasts).toHaveCount(2);
			await expect(toast(page, "Claude Code needs your input")).toBeVisible();

			// Every control along the composer's bottom edge, the corner the toasts start in.
			const controls = view
				.getByTestId("chat-composer")
				.locator('button, [role="textbox"]');
			expect(await controls.count()).toBeGreaterThan(5);
			for (const control of await controls.all()) {
				await control.focus();
				await expect(control).toBeFocused();
				await expect
					.poll(async () => {
						const at = await control.boundingBox();
						const boxes = await Promise.all(
							(await toasts.all()).map((one) => one.boundingBox()),
						);
						return boxes.some((box) => at !== null && box !== null && overlap(at, box));
					})
					.toBe(false);
			}
			await expectNoViolations(page, ".pk-toast");
		});

		test("the question pager says why an arrow is unavailable", async ({
			page,
			context,
		}) => {
			const { id } = await makeChatTab(page, context);
			const view = await scriptChat(page, id, {
				snapshot: { cards: [QUESTIONS], turnRunning: true },
			});
			const card = view.getByTestId("chat-question-card");
			const back = card.getByRole("button", { name: "Previous question" });
			const forward = card.getByRole("button", { name: "Next question" });
			await expect(back).toHaveAttribute("aria-disabled", "true");
			await expect(back).toHaveAccessibleDescription("This is the first question.");
			await expect(forward).toHaveAccessibleDescription(/skip this question/);
			await card.getByRole("radio", { name: "Stack" }).check();
			await expect(forward).toHaveAccessibleDescription("Use Next to go on.");
			await card.getByRole("button", { name: "Next", exact: true }).click();
			await expect(back).not.toHaveAttribute("aria-disabled", "true");
			await expect(back).not.toHaveAttribute("aria-describedby");
			await expectNoViolations(page, '[data-testid="chat-question-card"]');
		});

		test("image syntax in code is shown and copied as written; a reply's image opens by name", async ({
			page,
			context,
		}) => {
			await context.grantPermissions(["clipboard-read", "clipboard-write"]);
			const { id, student, project } = await makeChatTab(page, context);
			await seedFile(
				student.workspaceId,
				project.slug,
				".portikus/images/diagram.png",
				Buffer.from(png(200, 120), "base64"),
			);
			const view = await scriptChat(page, id, {
				first: [
					[
						"message",
						{
							id: "u1",
							role: "user",
							markdown: "Why does `![logo](logo.png)` not show?",
						},
					],
					["message", { id: "a1", role: "assistant", markdown: CODE_REPLY }],
				],
			});
			const sent = view.getByTestId("chat-user-message");
			await expect(sent.locator("code")).toHaveText("![logo](logo.png)");
			const reply = view.getByTestId("chat-assistant-message");
			await expect(reply.locator("p code")).toHaveText("![logo](logo.png)");
			await expect(reply.locator("pre")).toHaveText(`${FENCE}\n`);
			await reply.getByRole("button", { name: "Copy code" }).click();
			expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(FENCE);
			// The image outside code is a button that says it opens the image.
			await expect(
				reply.getByRole("button", { name: "View image Diagram", exact: true }),
			).toBeVisible();
			await expectNoViolations(page, '[data-testid="chat-assistant-message"]');
		});
	});
}

const FENCE = "![logo](logo.png)\n[run](javascript:alert(1))";
const CODE_REPLY = [
	"Use `![logo](logo.png)` in your README:",
	"",
	"```md",
	FENCE,
	"```",
	"",
	"![Diagram](.portikus/images/diagram.png)",
].join("\n");

const QUESTIONS = {
	type: "question",
	id: "q1",
	questions: [
		{
			question: "Which layout?",
			header: "Layout",
			multiSelect: false,
			options: [
				{ label: "Grid", description: "Rows and columns" },
				{ label: "Stack", description: "One column" },
			],
		},
		{
			question: "Which checks?",
			header: "Checks",
			multiSelect: true,
			options: [
				{ label: "Lint", description: "" },
				{ label: "Types", description: "" },
			],
		},
	],
};
