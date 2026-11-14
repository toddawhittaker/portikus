import { expect, type Page, test } from "@playwright/test";
import { type ChatAgent, inBothThemes, openChat, receivedFrames } from "./chat-helpers";
import { createStudent, expectNoViolations, query, terminalIds } from "./helpers";
import { FAKE_AGENT_URL } from "./ports";

/**
 * The sign-in warning above a chat's message box (SPEC.md §10.8, §25.8):
 * the host says the student is signed out of the chat's agent, the chat
 * says so before a message fails, opens the agent's own terminal to sign
 * in, and Check again asks the host once more. Sending stays possible.
 */

const NAME: Record<ChatAgent, string> = { claude: "Claude Code", codex: "Codex" };

/** What the fake host says of the sign-in now, and what a Check again finds. */
async function setSignIn(id: string, state: string, afterCheck?: string) {
	const response = await fetch(`${FAKE_AGENT_URL}/__test/chats/${id}/sign-in`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ state, ...(afterCheck ? { afterCheck } : {}) }),
	});
	expect(response.status).toBe(204);
}

/** Run `check` in a 360 px window, both themes, then give the window back. */
async function atPhoneWidth(page: Page, check: () => Promise<void>) {
	const wide = page.viewportSize() ?? { width: 1280, height: 720 };
	await page.setViewportSize({ width: 360, height: 800 });
	await inBothThemes(page, check);
	await page.emulateMedia({ colorScheme: "dark" });
	await page.setViewportSize(wide);
}

test.describe("the sign-in warning", () => {
	test.describe.configure({ timeout: 120_000 });

	for (const agent of ["codex", "claude"] as const) {
		test(`a ${NAME[agent]} chat warns above the message box, and Check again clears it`, async ({
			page,
			context,
		}) => {
			await page.emulateMedia({ colorScheme: "dark" });
			const student = await createStudent(context);
			const { id, view } = await openChat(
				page,
				student.workspaceId,
				`Sign-in ${agent}`,
				agent,
			);
			const banner = view.getByTestId("chat-sign-in");
			await expect(banner).toHaveCount(0);

			await setSignIn(id, "signedOut", "signedIn");
			await expect(banner).toBeVisible();
			await expect(banner.getByRole("status")).toContainText(
				`You're not signed in to ${NAME[agent]}.`,
			);
			await expect(
				banner.getByRole("button", { name: `Open ${NAME[agent]} (TUI)` }),
			).toBeVisible();
			// The warning sits above the message box.
			const bannerBox = await banner.boundingBox();
			const composerBox = await view.getByTestId("chat-composer-input").boundingBox();
			expect((bannerBox?.y ?? 0) + (bannerBox?.height ?? 0)).toBeLessThanOrEqual(
				composerBox?.y ?? 0,
			);

			await expectNoViolations(page, `[data-testid="chat-view-${id}"] .pk-chat-signin`);
			await atPhoneWidth(page, async () => {
				await expect(banner).toBeVisible();
				const width = await banner.evaluate((node) => ({
					scroll: node.scrollWidth,
					client: node.clientWidth,
				}));
				expect(width.scroll).toBeLessThanOrEqual(width.client);
				await expectNoViolations(
					page,
					`[data-testid="chat-view-${id}"] .pk-chat-signin`,
				);
			});

			// A reload asks the host again; the warning comes back with the attach.
			await page.reload();
			await expect(banner).toBeVisible({ timeout: 15_000 });

			await banner.getByRole("button", { name: "Check again" }).click();
			await expect(banner).toHaveCount(0);
			expect(await receivedFrames(id, "signIn.check")).toHaveLength(1);
		});
	}

	test("Check again that finds the student still signed out says so", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const { id, view } = await openChat(
			page,
			student.workspaceId,
			"Still out",
			"codex",
		);
		await setSignIn(id, "signedOut");
		const banner = view.getByTestId("chat-sign-in");
		await banner.getByRole("button", { name: "Check again" }).click();
		await expect(banner.getByRole("status")).toContainText("Still not signed in.");
		// The warning never blocks a send.
		const box = view.getByTestId("chat-composer-input");
		await box.click();
		await box.fill("hello");
		await box.press("Enter");
		await expect.poll(async () => (await receivedFrames(id, "send")).length).toBe(1);
	});

	for (const agent of ["codex", "claude"] as const) {
		test(`the terminal button opens and selects a ${NAME[agent]} (TUI) tab`, async ({
			page,
			context,
		}) => {
			const student = await createStudent(context);
			const { id, view, project } = await openChat(
				page,
				student.workspaceId,
				`Terminal ${agent}`,
				agent,
			);
			await setSignIn(id, "signedOut");
			const before = await terminalIds(student.workspaceId, project.id);
			await view
				.getByTestId("chat-sign-in")
				.getByRole("button", { name: `Open ${NAME[agent]} (TUI)` })
				.click();
			await expect
				.poll(async () => (await terminalIds(student.workspaceId, project.id)).length)
				.toBe(before.length + 1);
			const created = (await terminalIds(student.workspaceId, project.id)).find(
				(one) => !before.includes(one),
			);
			const rows = await query<{ kind: string; agent: string }>(
				"select kind, agent from terminals where id = $1",
				[created],
			);
			expect(rows[0]).toEqual({ kind: "terminal", agent });
			await expect(
				page.getByRole("tab", { name: new RegExp(`${NAME[agent]} \\(TUI\\)`) }),
			).toHaveAttribute("aria-selected", "true");
		});
	}
});
