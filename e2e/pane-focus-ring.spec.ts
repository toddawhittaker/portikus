import { expect, type Locator, type Page, test } from "@playwright/test";
import { openChat } from "./chat-helpers";
import { createStudent, expectConnected, terminalIds } from "./helpers";
import { splitPane } from "./split-helpers";

/**
 * The pane that has the keyboard, in a tab with more than one pane, wears
 * a focus ring all the way round: top, bottom and both sides, whatever the
 * pane holds and at any zoom (SPEC.md §25.8 visible focus, §13.1 zoom).
 * Measured from the screen, so a child painting over the ring fails.
 */

type Rgb = [number, number, number];

function hex(value: string): Rgb {
	const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value.trim());
	if (!match) throw new Error(`not a hex colour: ${value}`);
	return [1, 2, 3].map((group) => Number.parseInt(match[group] ?? "0", 16)) as Rgb;
}

/** The pane's focus colour, which follows its own scheme. */
async function focusColour(pane: Locator): Promise<Rgb> {
	return hex(
		await pane.evaluate((node) => getComputedStyle(node).getPropertyValue("--focus")),
	);
}

/**
 * The colour on screen one pixel inside the middle of each edge of `pane`,
 * read from a screenshot of the page so it is what the student sees.
 */
async function edgeColours(page: Page, pane: Locator): Promise<Record<string, Rgb>> {
	const box = await pane.boundingBox();
	if (!box) throw new Error("the pane has no box");
	const shot = (await page.screenshot()).toString("base64");
	const x0 = Math.ceil(box.x);
	const y0 = Math.ceil(box.y);
	const x1 = Math.floor(box.x + box.width) - 1;
	const y1 = Math.floor(box.y + box.height) - 1;
	const midX = Math.round(box.x + box.width / 2);
	const midY = Math.round(box.y + box.height / 2);
	const points = {
		top: [midX, y0 + 1],
		bottom: [midX, y1 - 1],
		left: [x0 + 1, midY],
		right: [x1 - 1, midY],
		bottomLeft: [x0 + 1, y1 - 24],
		bottomRight: [x1 - 1, y1 - 24],
	};
	return page.evaluate(
		async ({ shot, points }) => {
			const image = new Image();
			image.src = `data:image/png;base64,${shot}`;
			await image.decode();
			const canvas = document.createElement("canvas");
			canvas.width = image.width;
			canvas.height = image.height;
			const context = canvas.getContext("2d");
			if (!context) throw new Error("no canvas");
			context.drawImage(image, 0, 0);
			const scale = image.width / window.innerWidth;
			const colours: Record<string, [number, number, number]> = {};
			for (const [edge, [x, y]] of Object.entries(points)) {
				const [r, g, b] = context.getImageData(
					Math.round((x ?? 0) * scale),
					Math.round((y ?? 0) * scale),
					1,
					1,
				).data;
				colours[edge] = [r ?? 0, g ?? 0, b ?? 0];
			}
			return colours;
		},
		{ shot, points },
	);
}

async function expectRingAllRound(page: Page, pane: Locator): Promise<void> {
	const want = await focusColour(pane);
	await expect
		.poll(async () => {
			const colours = await edgeColours(page, pane);
			return Object.entries(colours)
				.filter(([, got]) =>
					got.some((channel, i) => Math.abs(channel - (want[i] ?? 0)) > 24),
				)
				.map(([edge, got]) => `${edge} rgb(${got.join(",")})`);
		})
		.toEqual([]);
}

for (const theme of ["dark", "light"] as const) {
	test(`the focused pane's ring goes all the way round a chat and a terminal, at every zoom, in the ${theme} theme`, async ({
		page,
		context,
	}) => {
		await context.addInitScript((value) => {
			localStorage.setItem("pk-theme", value);
		}, theme);
		const student = await createStudent(context);
		const {
			project,
			id: chat,
			view,
		} = await openChat(page, student.workspaceId, "Ring");
		await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
		await splitPane(page, chat, "right");
		await expect
			.poll(async () => (await terminalIds(student.workspaceId, project.id)).length)
			.toBe(2);
		const shell = (await terminalIds(student.workspaceId, project.id)).find(
			(one) => one !== chat,
		);
		if (!shell) throw new Error("the split's terminal was not created");
		await expectConnected(page, shell);

		const chatPane = page.getByTestId(`terminal-leaf-${chat}`);
		await view.getByTestId("chat-composer-input").click();
		await expect(chatPane).toHaveClass(/is-focused/);
		await expectRingAllRound(page, chatPane);

		for (let step = 0; step < 5; step += 1) {
			await page.getByTestId(`pane-zoom-out-${chat}`).click();
		}
		await expect(page.getByTestId(`pane-zoom-${chat}`)).toHaveText("50%");
		await view.getByTestId("chat-composer-input").click();
		await expectRingAllRound(page, chatPane);

		for (let step = 0; step < 15; step += 1) {
			await page.getByTestId(`pane-zoom-in-${chat}`).click();
		}
		await expect(page.getByTestId(`pane-zoom-${chat}`)).toHaveText("200%");
		await view.getByTestId("chat-composer-input").click();
		await expectRingAllRound(page, chatPane);

		const shellPane = page.getByTestId(`terminal-leaf-${shell}`);
		await shellPane.locator(".xterm").click();
		await expect(shellPane).toHaveClass(/is-focused/);
		await expect(chatPane).not.toHaveClass(/is-focused/);
		await expectRingAllRound(page, shellPane);
	});
}
