import { expect, type Locator, type Page, test } from "@playwright/test";
import { openChat } from "./chat-helpers";
import { createStudent, expectConnected, terminalIds } from "./helpers";
import { splitPane } from "./split-helpers";

/**
 * The pane that has the keyboard, in a tab with more than one pane, wears
 * a focus ring of one even width all the way round: top, bottom and both
 * sides, whatever the pane holds, wherever it sits in the split and at any
 * zoom (SPEC.md §25.8 visible focus, §13.1 zoom). Measured from the screen,
 * so a child or a splitter painting over the ring fails.
 */

type Rgb = [number, number, number];
type Edge = "top" | "bottom" | "left" | "right";

function hex(value: string): Rgb {
	const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value.trim());
	if (!match) throw new Error(`not a hex colour: ${value}`);
	return [1, 2, 3].map((group) => Number.parseInt(match[group] ?? "0", 16)) as Rgb;
}

/** A custom property's value on `node`, as a colour. */
async function colourOf(node: Locator, property: string): Promise<Rgb> {
	return hex(
		await node.evaluate(
			(element, name) => getComputedStyle(element).getPropertyValue(name),
			property,
		),
	);
}

/**
 * For each edge of `pane`, how many ring-coloured screen pixels lie across
 * it, at a quarter, half and three quarters of the way along. Only the
 * pane's own pixels count, so a ring-like colour next to the pane (the
 * active tab's underline) does not.
 */
async function ringWidths(
	page: Page,
	pane: Locator,
	ring: Rgb,
): Promise<Record<Edge, number[]>> {
	const box = await pane.boundingBox();
	if (!box) throw new Error("the pane has no box");
	const shot = (await page.screenshot()).toString("base64");
	return page.evaluate(
		async ({ shot, box, ring }) => {
			const image = new Image();
			image.src = `data:image/png;base64,${shot}`;
			await image.decode();
			const canvas = document.createElement("canvas");
			canvas.width = image.width;
			canvas.height = image.height;
			const context = canvas.getContext("2d");
			if (!context) throw new Error("no canvas");
			context.drawImage(image, 0, 0);
			const pixels = context.getImageData(0, 0, image.width, image.height).data;
			const scale = image.width / window.innerWidth;
			const isRing = (x: number, y: number) => {
				const at = (y * image.width + x) * 4;
				return ring.every(
					(channel, i) => Math.abs((pixels[at + i] ?? 0) - channel) <= 12,
				);
			};
			// Device pixels: the pane's first and last columns and rows.
			const left = Math.round(box.x * scale);
			const top = Math.round(box.y * scale);
			const right = Math.round((box.x + box.width) * scale) - 1;
			const bottom = Math.round((box.y + box.height) * scale) - 1;
			const run = (x: number, y: number, dx: number, dy: number) => {
				// The ring sits inside the pane: count across its outermost few pixels.
				let count = 0;
				for (let step = 0; step < 6 * scale; step += 1) {
					if (isRing(x + dx * step, y + dy * step)) count += 1;
				}
				return count / scale;
			};
			const along = [0.25, 0.5, 0.75];
			return {
				top: along.map((f) => run(Math.round(left + (right - left) * f), top, 0, 1)),
				bottom: along.map((f) =>
					run(Math.round(left + (right - left) * f), bottom, 0, -1),
				),
				left: along.map((f) => run(left, Math.round(top + (bottom - top) * f), 1, 0)),
				right: along.map((f) =>
					run(right, Math.round(top + (bottom - top) * f), -1, 0),
				),
			};
		},
		{ shot, box, ring },
	);
}

/** The ring is the theme's width, the same on all four edges. */
async function expectEvenRing(page: Page, pane: Locator): Promise<void> {
	await expect(pane).toHaveClass(/is-focused/);
	const ring = await colourOf(pane, "--focus");
	const width = Number.parseFloat(
		await pane.evaluate((node) =>
			getComputedStyle(node).getPropertyValue("--ring-width"),
		),
	);
	const even: Record<Edge, number[]> = {
		top: [width, width, width],
		bottom: [width, width, width],
		left: [width, width, width],
		right: [width, width, width],
	};
	await expect.poll(() => ringWidths(page, pane, ring)).toEqual(even);
}

async function zoomTo(page: Page, paneId: string, percent: number): Promise<void> {
	const value = page.getByTestId(`pane-zoom-${paneId}`);
	const now = Number.parseInt((await value.textContent()) ?? "100", 10);
	const button = percent > now ? "in" : "out";
	for (let step = 0; step < Math.abs(percent - now) / 10; step += 1) {
		await page.getByTestId(`pane-zoom-${button}-${paneId}`).click();
	}
	await expect(value).toHaveText(`${percent}%`);
}

/** The id of the one pane that is not in `known`, once it exists. */
async function newPane(workspaceId: string, projectId: string, known: string[]) {
	await expect
		.poll(async () => (await terminalIds(workspaceId, projectId)).length)
		.toBe(known.length + 1);
	const id = (await terminalIds(workspaceId, projectId)).find(
		(one) => !known.includes(one),
	);
	if (!id) throw new Error("the split's pane was not created");
	return id;
}

for (const theme of ["dark", "light"] as const) {
	test(`the focused pane's ring is even on all four edges, for chats and terminals anywhere in a split, at every zoom, in the ${theme} theme`, async ({
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

		// A chat on the left, a terminal on the right.
		await splitPane(page, chat, "right");
		const shell = await newPane(student.workspaceId, project.id, [chat]);
		await expectConnected(page, shell);

		// A chat follows the page's theme, so its ring takes the page's focus colour.
		const chatPane = page.getByTestId(`terminal-leaf-${chat}`);
		expect(await colourOf(chatPane, "--focus")).toEqual(
			await colourOf(page.locator("html"), "--focus"),
		);

		for (const percent of [100, 50, 150, 200]) {
			await zoomTo(page, chat, percent);
			await view.getByTestId("chat-composer-input").click();
			await expectEvenRing(page, chatPane);
		}

		const shellPane = page.getByTestId(`terminal-leaf-${shell}`);
		await shellPane.locator(".xterm").click();
		await expect(chatPane).not.toHaveClass(/is-focused/);
		await expectEvenRing(page, shellPane);

		// A chat under the terminal, on the right and below a splitter.
		await splitPane(page, shell, "down", "claude-gui");
		const lower = await newPane(student.workspaceId, project.id, [chat, shell]);
		const lowerView = page.getByTestId(`chat-view-${lower}`);
		await expect(lowerView.getByTestId("chat-composer-input")).toBeVisible({
			timeout: 15_000,
		});
		const lowerPane = page.getByTestId(`terminal-leaf-${lower}`);
		for (const percent of [100, 50, 150, 200]) {
			await zoomTo(page, lower, percent);
			await lowerView.getByTestId("chat-composer-input").click();
			await expectEvenRing(page, lowerPane);
		}
		await shellPane.locator(".xterm").click();
		await expectEvenRing(page, shellPane);
	});
}
