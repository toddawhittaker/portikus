import { expect, type Locator, type Page, test } from "@playwright/test";
import {
	chatTabIn,
	inBothThemes,
	openChat,
	openChatOptions,
	receivedFrames,
} from "./chat-helpers";
import {
	createProject,
	createStudent,
	expectNoViolations,
	query,
	workspacePath,
} from "./helpers";

/**
 * Skills, slash commands and the pickers of a Codex chat, against the
 * Claude ones (SPEC.md §10.8, §25.8), on the fake host.
 */

test.describe("skills and commands", () => {
	test.describe.configure({ timeout: 90_000 });

	test("a skill is /name in a Claude chat, $name in a Codex chat, and $ opens a skills-only list only for Codex", async ({
		page,
		context,
	}) => {
		await page.emulateMedia({ colorScheme: "dark" });
		const student = await createStudent(context);

		const claude = await openChat(page, student.workspaceId, "Skills Claude", "claude");
		const claudeBox = claude.view.getByTestId("chat-composer-input");
		await claudeBox.click();
		await page.keyboard.type("/pd");
		await expect(
			claude.view.getByRole("listbox", { name: "Commands" }).getByRole("option"),
		).toHaveText([/\/pdf/]);
		await page.keyboard.press("ControlOrMeta+a");
		await page.keyboard.press("Backspace");
		// In a Claude chat a dollar sign is only a dollar sign.
		await page.keyboard.type("$");
		await expect(claude.view.getByRole("listbox")).toHaveCount(0);
		await expect(claudeBox).toHaveText("$");

		const codex = await openChat(page, student.workspaceId, "Skills Codex", "codex");
		const box = codex.view.getByTestId("chat-composer-input");
		await box.click();
		await page.keyboard.type("/");
		const commands = codex.view.getByRole("listbox", { name: "Commands" });
		await expect(commands.getByRole("option", { name: /\$pdf/ })).toBeVisible();
		await expect(commands.getByRole("option", { name: /\/pdf/ })).toHaveCount(0);
		await expect(commands.getByRole("option", { name: /\/mcp/ })).toBeVisible();
		await page.keyboard.press("Escape");
		await page.keyboard.press("ControlOrMeta+a");
		await page.keyboard.press("Backspace");

		await page.keyboard.type("$");
		const skills = codex.view.getByRole("listbox", { name: "Skills" });
		await expect(skills.getByRole("option")).toHaveText([/\$pdf/]);
		await inBothThemes(page, () => expectNoViolations(page));
		await page.keyboard.press("Enter");
		await expect(box).toHaveText("$pdf");
		// A skill goes as plain text, which Codex expands itself.
		await page.keyboard.type("fill in the form");
		await page.keyboard.press("Enter");
		await expect
			.poll(async () => (await receivedFrames(codex.id, "send")).map((f) => f.text))
			.toEqual(["$pdf fill in the form"]);
	});

	test("/model, /effort and /permissions open their pickers in a Codex chat and are never sent", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const { id, view } = await openChat(page, student.workspaceId, "Bare", "codex");
		const box = view.getByTestId("chat-composer-input");
		for (const [command, picker] of [
			["/model", "composer-model"],
			["/effort", "composer-effort"],
			["/permissions", "composer-mode"],
		] as const) {
			await box.click();
			await page.keyboard.type(command);
			await page.keyboard.press("Escape");
			await page.keyboard.press("Enter");
			await expect(view.getByTestId(picker)).toHaveAttribute("aria-expanded", "true");
			await page.keyboard.press("Escape");
			await expect(box).toHaveText("");
		}
		expect(await receivedFrames(id, "send")).toEqual([]);
	});
});

test.describe("Codex pickers", () => {
	test.describe.configure({ timeout: 90_000 });

	/** The pickers, by test id: an open menu hides the rest of the page from role queries. */
	const picker = (view: Locator, testId: string) => view.getByTestId(testId);
	const menu = (page: Page, label: string) =>
		page.getByRole("menu", { name: new RegExp(`^${label} `) });

	test("each model lists its own efforts, and the five modes carry Full access's warning", async ({
		page,
		context,
	}) => {
		await page.emulateMedia({ colorScheme: "dark" });
		const student = await createStudent(context);
		const { view } = await openChat(page, student.workspaceId, "Codex models", "codex");
		await openChatOptions(view);

		await picker(view, "composer-effort").click();
		let efforts = menu(page, "Effort").getByRole("menuitemradio");
		await expect(efforts).toHaveText([
			/Low/,
			/Medium\s*Default/,
			/High/,
			/Extra high/,
			/ultra/,
		]);
		await page.keyboard.press("Escape");

		await picker(view, "composer-model").click();
		await menu(page, "Model")
			.getByRole("menuitemradio", { name: /GPT-5\.4 mini/ })
			.click();
		await expect(picker(view, "composer-model")).toHaveText(/GPT-5\.4 mini/);
		await picker(view, "composer-effort").click();
		efforts = menu(page, "Effort").getByRole("menuitemradio");
		await expect(efforts).toHaveText([/Low/, /Medium\s*Default/, /High/]);
		await page.keyboard.press("Escape");

		await picker(view, "composer-mode").click();
		const modes = menu(page, "Permissions").getByRole("menuitemradio");
		await expect(modes).toHaveText([/Ask/, /Read only/, /Plan/, /Auto/, /Full access/]);
		await modes.last().click();
		await expect(view.getByTestId("chat-bypass-warning")).toHaveText(
			"Full access lets Codex run every command without asking you first.",
		);
		await inBothThemes(page, () =>
			expectNoViolations(page, '[data-testid="composer-picks"]'),
		);
	});

	test("Full access is never carried into a new Codex chat, while the model and effort are", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await createProject(student.workspaceId, { name: "Carry" });
		// What a student's last Codex chat saved, Full access included; a new chat reads it as Auto.
		await query("update projects set chat_settings = $2 where id = $1", [
			project.id,
			JSON.stringify({
				model: "opus",
				effort: "medium",
				mode: "auto",
				agent: "codex",
				codex: { model: "gpt-5.4", effort: "high", mode: "fullAccess" },
			}),
		]);
		const tabId = await chatTabIn(page, student.workspaceId, project.id, "codex");
		const tab = { id: tabId };
		const sets: Record<string, unknown>[] = [];
		let current = { model: "gpt-5.5", effort: "medium", mode: "untrusted" };
		await page.routeWebSocket(/\/chat$/, (ws) => {
			let seq = 0;
			const send = (type: string, body: object = {}) =>
				ws.send(JSON.stringify({ type, sessionId: tab.id, seq: seq++, ...body }));
			send("snapshot", { cards: [], turnRunning: false, truncated: false });
			send("models", {
				models: [
					{
						value: "gpt-5.5",
						displayName: "GPT-5.5",
						description: "Frontier",
						supportsAutoMode: true,
						efforts: ["low", "medium", "high", "ultra"],
						defaultEffort: "medium",
					},
					{
						value: "gpt-5.4",
						displayName: "GPT-5.4",
						description: "Everyday",
						supportsAutoMode: true,
						efforts: ["low", "medium", "high"],
						defaultEffort: "medium",
					},
				],
			});
			send("modes", {
				modes: [
					{
						id: "untrusted",
						label: "Ask",
						description: "Asks.",
						warning: false,
						plan: false,
					},
					{
						id: "onRequest",
						label: "Auto",
						description: "Auto.",
						warning: false,
						plan: false,
					},
					{
						id: "fullAccess",
						label: "Full access",
						description:
							"Full access lets Codex run every command without asking you first.",
						warning: true,
						plan: false,
					},
				],
			});
			send("settings", { agent: "codex", ...current });
			ws.onMessage((raw) => {
				const message = JSON.parse(String(raw));
				if (message.type !== "set") return;
				sets.push(message);
				const { type: _type, ...change } = message;
				current = { ...current, ...change };
				send("settings", { agent: "codex", ...current });
			});
		});
		await page.goto(workspacePath(student.workspaceId, project.id));
		const view = page.getByTestId(`chat-view-${tab.id}`);
		await expect(view.getByTestId("composer-model")).toBeAttached({ timeout: 15_000 });
		await openChatOptions(view);
		await expect(view.getByTestId("composer-model")).toHaveText(/GPT-5\.4/, {
			timeout: 15_000,
		});
		await openChatOptions(view);
		await expect(view.getByTestId("composer-effort")).toHaveText(/High/);
		await expect(view.getByTestId("composer-mode")).toHaveText(/Auto/);
		await expect(view.getByTestId("chat-bypass-warning")).toHaveCount(0);
		for (const set of sets) expect(set.mode).not.toBe("fullAccess");
	});

	test("Claude's pickers keep Claude's own models, efforts and modes", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const { view } = await openChat(
			page,
			student.workspaceId,
			"Claude pickers",
			"claude",
		);
		await openChatOptions(view);
		await expect(view.getByTestId("composer-agent")).toHaveText(/Claude Code/);
		await view.getByTestId("composer-mode").click();
		await expect(menu(page, "Permissions").getByRole("menuitemradio")).toHaveText([
			/Ask/,
			/Accept edits/,
			/Plan/,
			/Auto/,
			/Bypass permissions/,
		]);
		await page.keyboard.press("Escape");
		await view.getByTestId("composer-effort").click();
		await expect(
			menu(page, "Effort").getByRole("menuitemradio", { name: /ultra/ }),
		).toHaveCount(0);
		await page.keyboard.press("Escape");
		await view.getByTestId("composer-model").click();
		await expect(
			menu(page, "Model").getByRole("menuitemradio", { name: /GPT/ }),
		).toHaveCount(0);
	});
});
