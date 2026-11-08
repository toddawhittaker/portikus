import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	expectNoViolations,
	newTerminal,
	query,
	seedFile,
	terminalIds,
	workspacePath,
	workTabs,
} from "./helpers";
import { png } from "./png";

/**
 * Images in the chat (SPEC.md §10.8, §24.1): a reply shows the student's own
 * image files through the owner-only image route and names remote ones
 * without loading them; any image opens large in a viewer.
 */

const REPLY = [
	"Here is the screenshot: ![Portfolio screenshot](.portikus/images/home.png)",
	"",
	"![tracking](https://remote-image.example/leak.png?q=secret)",
	"",
	"![Old shot](.portikus/images/gone.png)",
].join("\n");

/** A picture the student pasted and sent, as the composer saves it. */
const SENT_IMAGE = ".portikus/pastes/2026-11-08T03-06-53/image.png";

async function openChatWithImage(page: Page, context: BrowserContext) {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "Portfolio" });
	await seedFile(
		student.workspaceId,
		project.slug,
		".portikus/images/home.png",
		Buffer.from(png(320, 180), "base64"),
	);
	await seedFile(
		student.workspaceId,
		project.slug,
		SENT_IMAGE,
		Buffer.from(png(200, 120), "base64"),
	);
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
	await page.routeWebSocket(/\/chat$/, (ws) => {
		let seq = 0;
		const send = (type: string, body: Record<string, unknown> = {}) =>
			ws.send(
				JSON.stringify({
					type,
					sessionId: "00000000-0000-4000-8000-000000000000",
					seq: seq++,
					...body,
				}),
			);
		send("snapshot", { cards: [], turnRunning: false, truncated: false });
		send("message", {
			id: "u1",
			role: "user",
			markdown: "Show me a screenshot.",
			attachments: [{ path: SENT_IMAGE }, { path: "notes/todo.txt" }],
		});
		send("turn.started", { at: Date.now() - 5_000 });
		send("tool.started", { id: "t1", name: "Screenshot", title: "home", input: {} });
		send("tool.output", {
			id: "t1",
			part: { type: "image", mediaType: "image/png", data: png(320, 180) },
		});
		send("tool.finished", { id: "t1", isError: false });
		send("message", { id: "a1", role: "assistant", markdown: REPLY });
		send("turn.finished", { at: Date.now(), status: "done" });
		send("settings", {
			agent: "claude",
			model: "default",
			effort: "high",
			mode: "default",
		});
	});
	const remote: string[] = [];
	page.on("request", (request) => {
		if (request.url().includes("remote-image.example")) remote.push(request.url());
	});
	await page.reload();
	const view = page.getByTestId(`chat-view-${id}`);
	await expect(view).toBeVisible({ timeout: 15_000 });
	return { view, remote };
}

for (const colorScheme of ["light", "dark"] as const) {
	test(`a local image in a reply shows and opens by keyboard (${colorScheme})`, async ({
		page,
		context,
	}) => {
		test.setTimeout(90_000);
		await page.emulateMedia({ colorScheme });
		const { view, remote } = await openChatWithImage(page, context);

		const image = view.getByRole("img", { name: "Portfolio screenshot" });
		await expect(image).toBeVisible();
		// The image really loaded through the image route.
		await expect
			.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth))
			.toBe(320);
		await expect(
			view.getByText("Remote image not shown: remote-image.example"),
		).toBeVisible();
		await expect(
			view.getByText("Image not found: .portikus/images/gone.png"),
		).toBeVisible();
		await expect(view).not.toContainText("!tracking");
		expect(remote).toEqual([]);
		await expectNoViolations(page, `[data-testid^="chat-view-"]`);

		const opener = view.getByRole("button", { name: "Portfolio screenshot" });
		await opener.focus();
		await page.keyboard.press("Enter");
		const dialog = page.getByRole("dialog", { name: "home.png" });
		await expect(dialog).toBeVisible();
		await expect(
			dialog.getByRole("img", { name: "Portfolio screenshot" }),
		).toBeVisible();
		await expectNoViolations(page, '[data-testid="chat-image-viewer"]');
		await page.keyboard.press("Escape");
		await expect(dialog).toHaveCount(0);
		await expect(opener).toBeFocused();
	});
}

test("Open in editor opens the image in a work tab", async ({ page, context }) => {
	test.setTimeout(90_000);
	const { view } = await openChatWithImage(page, context);
	await view.getByRole("button", { name: "Portfolio screenshot" }).click();
	const dialog = page.getByRole("dialog", { name: "home.png" });
	await dialog.getByRole("button", { name: "Open in editor" }).click();
	await expect(dialog).toHaveCount(0);
	await expect(workTabs(page).getByRole("tab", { name: /home\.png/ })).toBeVisible();
});

test("a tool's image opens in the same viewer", async ({ page, context }) => {
	test.setTimeout(90_000);
	const { view } = await openChatWithImage(page, context);
	await view.getByTestId("chat-worked").locator("> summary").click();
	await view.getByTestId("chat-tool-t1").locator("> summary").click();
	await view.getByRole("button", { name: "Output of Screenshot" }).click();
	const dialog = page.getByRole("dialog", { name: "Output of Screenshot" });
	await expect(dialog.getByRole("img", { name: "Output of Screenshot" })).toBeVisible();
	await expect(dialog.getByRole("button", { name: "Open in editor" })).toHaveCount(0);
});

test("a sent picture is a thumbnail that opens large and gives focus back", async ({
	page,
	context,
}) => {
	test.setTimeout(90_000);
	const { view } = await openChatWithImage(page, context);
	const sent = view.getByTestId("chat-user-message");
	// Another file keeps its path.
	await expect(sent.getByText("notes/todo.txt")).toBeVisible();
	const thumb = sent.getByRole("button", { name: "View image image.png" });
	const image = thumb.getByRole("img", { name: "image.png" });
	await expect
		.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth))
		.toBe(200);
	await expect(image).toHaveJSProperty("clientWidth", 56);

	await thumb.focus();
	await page.keyboard.press("Enter");
	const dialog = page.getByRole("dialog", { name: "image.png" });
	await expect(dialog.getByRole("img", { name: "image.png" })).toBeVisible();
	await expect(dialog.getByRole("button", { name: "Open in editor" })).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(dialog).toHaveCount(0);
	await expect(thumb).toBeFocused();
});
