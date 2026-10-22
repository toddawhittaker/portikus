import { type Browser, expect, type Page, test } from "@playwright/test";
import {
	codeHelpStatus,
	editorLines,
	holdCodeHelpSwitch,
	openProjectFiles,
	watchLanguageServers,
} from "./code-help-helpers";
import {
	API_ORIGIN,
	createStudent,
	lockSharedState,
	loginAs,
	query,
	VOICE_SWITCH_LOCK,
	WEB_ORIGIN,
} from "./helpers";

/**
 * Code help chosen per language on the Settings tab (SPEC.md section 13.6):
 * one box per shipped language, saved with Student tools, audited with the
 * sets before and after; a student's file of an unticked language gets the
 * plain editor while the others keep code help. Languages not shipped yet
 * are listed, cannot be ticked, and say why (SPEC.md section 25.8).
 */

async function openTools(page: Page) {
	await loginAs(page, "carol");
	await page.goto("/admin/settings");
	const tools = page.getByRole("region", { name: "Student tools" });
	await expect(tools.getByRole("checkbox", { name: "Allow voice input" })).toBeVisible({
		timeout: 15_000,
	});
	return tools;
}

async function adminPage(browser: Browser) {
	const context = await browser.newContext();
	return { context, page: await context.newPage() };
}

const COMING_LATER = ["HTML, CSS and JSON", "Java", "C and C++", "SQL"];

test.describe("languages not shipped yet", () => {
	test("are listed, cannot be ticked, stay in the tab order and say why", async ({
		page,
	}) => {
		const tools = await openTools(page);
		for (const name of COMING_LATER) {
			const box = tools.getByRole("checkbox", { name, exact: true });
			await expect(box).toHaveAttribute("aria-disabled", "true");
			await expect(box).not.toBeChecked();
			await expect(box).toHaveAccessibleDescription(
				/Coming later: .* cannot be ticked\./,
			);
			// Playwright counts aria-disabled as disabled; the box itself must not be.
			await expect(box).not.toHaveAttribute("disabled");
			await box.focus();
			await expect(box).toBeFocused();
			await page.keyboard.press("Space");
			await box.click({ force: true });
			await expect(box).not.toBeChecked();
		}
		await expect(page.getByTestId("settings-tools-state")).toHaveText(
			"No unsaved changes.",
		);
		await expect(page.getByTestId("code-help-languages")).toContainText("Coming later");
	});

	test("the API refuses a language that has not shipped, a duplicate, and a non-array", async ({
		page,
	}) => {
		await loginAs(page, "carol");
		await page.goto("/admin/settings");
		for (const codeHelpLanguages of [["java"], ["python", "python"], "python"]) {
			const response = await page.request.put(`${API_ORIGIN}/admin/settings`, {
				headers: { origin: WEB_ORIGIN },
				data: { codeHelpLanguages },
			});
			expect(response.status(), JSON.stringify(codeHelpLanguages)).toBe(400);
		}
	});
});

test.describe("turning one language off and on", () => {
	test.describe.configure({ mode: "serial", timeout: 180_000 });
	holdCodeHelpSwitch(test, { alone: true });

	test("unticking Python gives its files the plain editor, and TypeScript keeps code help", async ({
		browser,
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const admin = await adminPage(browser);
		try {
			const tools = await openTools(admin.page);
			const python = tools.getByRole("checkbox", { name: "Python" });
			await expect(python).toBeChecked();
			const puts: unknown[] = [];
			admin.page.on("request", (request) => {
				if (
					request.method() === "PUT" &&
					new URL(request.url()).pathname === "/admin/settings"
				)
					puts.push(request.postDataJSON());
			});

			await python.click();
			await expect(tools).toContainText("Not saved. Was on.");
			await tools.getByRole("button", { name: "Save student tools" }).click();
			await expect(admin.page.getByTestId("settings-tools-state")).toHaveText("Saved.");
			expect(puts).toEqual([{ codeHelpLanguages: ["typescript"] }]);
			const [stored] = await query<{ languages: string[] }>(
				"select code_help_languages as languages from settings where id = 1",
			);
			expect(stored?.languages).toEqual(["typescript"]);
			const [audit] = await query<{ metadata: Record<string, unknown> }>(
				"select metadata from audit_events where action = 'settings.code_help_updated' order by id desc limit 1",
			);
			expect(audit?.metadata).toMatchObject({
				from: ["python", "typescript"],
				to: ["typescript"],
			});

			const wire = await watchLanguageServers(page);
			await openProjectFiles(page, student, "Languages", {
				"app.py": "answer = 42\n",
				"app.ts": "export const answer: number = 42;\n",
			});
			await expect(editorLines(page, "app.py")).toContainText("answer", {
				timeout: 60_000,
			});
			await page.getByTestId("tab-file:app.ts").click();
			await expect(codeHelpStatus(page, "app.ts")).toHaveText("Code help ready", {
				timeout: 30_000,
			});
			await page.getByTestId("tab-file:app.py").click();
			await expect(codeHelpStatus(page, "app.py")).toHaveCount(0);
			expect(wire.opened("python")).toBe(0);
			expect(wire.opened("ruff")).toBe(0);
			expect(wire.opened("typescript")).toBeGreaterThan(0);
			// Code help is still on for a language, so the Problems tab stays.
			await expect(page.getByRole("tab", { name: "Problems" })).toBeVisible();

			// Ticking it again gives Python files code help at the next page load.
			await python.click();
			await tools.getByRole("button", { name: "Save student tools" }).click();
			await expect(admin.page.getByTestId("settings-tools-state")).toHaveText("Saved.");
			expect(puts[1]).toEqual({ codeHelpLanguages: ["python", "typescript"] });
			const [back] = await query<{ metadata: Record<string, unknown> }>(
				"select metadata from audit_events where action = 'settings.code_help_updated' order by id desc limit 1",
			);
			expect(back?.metadata).toMatchObject({
				from: ["typescript"],
				to: ["python", "typescript"],
			});

			await page.reload();
			await expect(editorLines(page, "app.py")).toContainText("answer", {
				timeout: 60_000,
			});
			await expect(codeHelpStatus(page, "app.py")).toHaveText("Code help ready", {
				timeout: 30_000,
			});
			expect(wire.opened("python")).toBeGreaterThan(0);
		} finally {
			await admin.context.close();
		}
	});

	test("saving the same set again writes no audit row", async ({ page }) => {
		const tools = await openTools(page);
		const [{ count: before } = { count: 0 }] = await query<{ count: number }>(
			"select count(*)::int as count from audit_events where action = 'settings.code_help_updated'",
		);
		const python = tools.getByRole("checkbox", { name: "Python" });
		// Off and back on is no change, so there is nothing to save.
		await python.click();
		await python.click();
		await expect(page.getByTestId("settings-tools-state")).toHaveText(
			"No unsaved changes.",
		);
		const response = await page.request.put(`${API_ORIGIN}/admin/settings`, {
			headers: { origin: WEB_ORIGIN },
			data: { codeHelpLanguages: ["typescript", "python"] },
		});
		expect(response.status()).toBe(200);
		const [{ count: after } = { count: 0 }] = await query<{ count: number }>(
			"select count(*)::int as count from audit_events where action = 'settings.code_help_updated'",
		);
		expect(after).toBe(before);
	});
});

test.describe("voice input saved alone", () => {
	test.describe.configure({ mode: "serial" });
	holdCodeHelpSwitch(test, { alone: true });
	let releaseVoice: (() => Promise<void>) | undefined;
	test.beforeAll(async () => {
		test.setTimeout(600_000);
		releaseVoice = await lockSharedState(VOICE_SWITCH_LOCK);
	});
	test.afterAll(async () => {
		await query("update settings set voice_input_enabled = true where id = 1");
		await releaseVoice?.();
	});

	test("sends only voice input and leaves the language set as it is", async ({
		page,
	}) => {
		await query(
			"update settings set code_help_languages = '{typescript}', voice_input_enabled = true where id = 1",
		);
		const tools = await openTools(page);
		const puts: unknown[] = [];
		page.on("request", (request) => {
			if (
				request.method() === "PUT" &&
				new URL(request.url()).pathname === "/admin/settings"
			)
				puts.push(request.postDataJSON());
		});
		await tools.getByRole("checkbox", { name: "Allow voice input" }).click();
		await tools.getByRole("button", { name: "Save student tools" }).click();
		await expect(page.getByTestId("settings-tools-state")).toHaveText("Saved.");
		expect(puts).toEqual([{ voiceInputEnabled: false }]);
		const [row] = await query<{ languages: string[]; voice: boolean }>(
			"select code_help_languages as languages, voice_input_enabled as voice from settings where id = 1",
		);
		expect(row).toEqual({ languages: ["typescript"], voice: false });
	});
});
