import { expect, type Page, test } from "@playwright/test";
import { openChat, receivedFrames } from "./chat-helpers";
import { createStudent, expectNoViolations } from "./helpers";

/**
 * Insert as text on a long paste's chip (SPEC.md §10.8, §25.8): an untimed
 * way to put the paste in the message box, so nobody has to paste twice
 * within 0.8 seconds. The fake agent records every frame the page sends.
 */

const COMPOSER = '[data-testid="chat-composer"]';

/** Paste `count` lines of log as a browser would. */
async function pasteLog(page: Page, count: number) {
	await page.evaluate((lines) => {
		const transfer = new DataTransfer();
		transfer.setData(
			"text/plain",
			Array.from({ length: lines }, (_, at) => `Error: step ${at} failed`).join("\n"),
		);
		document.querySelector('[data-testid="chat-composer-input"]')?.dispatchEvent(
			new ClipboardEvent("paste", {
				clipboardData: transfer,
				bubbles: true,
				cancelable: true,
			}),
		);
	}, count);
}

/** Every DELETE request the page makes, by URL. */
function watchDeletes(page: Page): string[] {
	const deletes: string[] = [];
	page.on("request", (request) => {
		if (request.method() === "DELETE") deletes.push(request.url());
	});
	return deletes;
}

for (const colorScheme of ["light", "dark"] as const) {
	test(`Insert as text puts the paste in the box at the cursor and deletes its file (${colorScheme})`, async ({
		page,
		context,
	}) => {
		await page.emulateMedia({ colorScheme });
		const student = await createStudent(context);
		const { id, view } = await openChat(page, student.workspaceId, "Insert");
		const box = view.getByTestId("chat-composer-input");
		await box.click();
		await box.pressSequentially("see ");
		await pasteLog(page, 60);
		const chip = view.getByTestId("composer-chip");
		await expect(chip).toHaveCount(1);
		await expect(box).toHaveText("see");
		const insert = chip.getByRole("button", {
			name: "Insert pasted text inline (pasted-text.txt)",
		});
		await expect(insert).toBeVisible();
		await expectNoViolations(page, COMPOSER);
		const deleted = page.waitForResponse(
			(response) =>
				response.request().method() === "DELETE" &&
				response.url().includes("pasted-text.txt"),
		);
		await insert.click();
		await expect(view.getByTestId("composer-chip")).toHaveCount(0);
		await expect(view.getByTestId("chat-composer-status")).toHaveText(
			"Inserted 60 lines as text.",
		);
		expect((await deleted).ok()).toBe(true);
		await expect(box.locator("p")).toHaveCount(60);
		// The cursor sits at the end of the inserted text, in the box.
		await expect(box).toBeFocused();
		await page.keyboard.type(" done");
		await expectNoViolations(page, COMPOSER);
		await box.press("Enter");
		await expect.poll(async () => (await receivedFrames(id, "send")).length).toBe(1);
		const [frame] = await receivedFrames(id, "send");
		expect(frame?.attachments).toEqual([]);
		const lines = String(frame?.text).split("\n");
		expect(lines).toHaveLength(60);
		expect(lines[0]).toBe("see Error: step 0 failed");
		expect(lines[59]).toBe("Error: step 59 failed done");
	});
}

test("Insert as text works from the keyboard alone, and Remove stays a Tab away", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const { view } = await openChat(page, student.workspaceId, "Insert keys");
	const box = view.getByTestId("chat-composer-input");
	await box.click();
	await pasteLog(page, 45);
	const chip = view.getByTestId("composer-chip");
	await expect(chip).toHaveCount(1);
	const insert = chip.getByRole("button", { name: /^Insert pasted text inline/ });
	await insert.focus();
	await page.keyboard.press("Tab");
	await expect(chip.getByRole("button", { name: "Remove pasted-text.txt" })).toBeFocused();
	await page.keyboard.press("Shift+Tab");
	await expect(insert).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(view.getByTestId("composer-chip")).toHaveCount(0);
	await expect(box.locator("p")).toHaveCount(45);
	await expect(box).toBeFocused();
});

test("a paste that was sent keeps its file: no Insert as text for it, and nothing is deleted", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const { id, view } = await openChat(page, student.workspaceId, "Insert sent");
	const deletes = watchDeletes(page);
	const box = view.getByTestId("chat-composer-input");
	await box.click();
	await pasteLog(page, 60);
	await expect(view.getByTestId("composer-chip")).toHaveCount(1);
	await box.press("Enter");
	await expect.poll(async () => (await receivedFrames(id, "send")).length).toBe(1);
	const [frame] = await receivedFrames(id, "send");
	expect(frame?.attachments).toEqual([
		{ path: expect.stringMatching(/^\.portikus\/pastes\/[^/]+\/pasted-text\.txt$/) },
	]);
	// Once the host echoes the message, the chip goes with it and the file stays.
	await expect(view.getByTestId("composer-chip")).toHaveCount(0);
	await expect(box).toHaveText("");
	expect(deletes).toEqual([]);
});

test("the 0.8-second double paste still puts a long paste inline", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const { view } = await openChat(page, student.workspaceId, "Insert both");
	const box = view.getByTestId("chat-composer-input");
	await box.click();
	await page.evaluate(() => {
		const log = Array.from({ length: 60 }, (_, at) => `Error: step ${at} failed`);
		for (let i = 0; i < 2; i += 1) {
			const transfer = new DataTransfer();
			transfer.setData("text/plain", log.join("\n"));
			document.querySelector('[data-testid="chat-composer-input"]')?.dispatchEvent(
				new ClipboardEvent("paste", {
					clipboardData: transfer,
					bubbles: true,
					cancelable: true,
				}),
			);
		}
	});
	await expect(view.getByTestId("chat-composer-status")).toHaveText(
		"Pasted 60 lines inline.",
	);
	await expect(view.getByTestId("composer-chip")).toHaveCount(0);
	await expect(box.locator("p")).toHaveCount(60);
});
