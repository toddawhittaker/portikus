import { expect, type Locator, type Page, test } from "@playwright/test";
import {
	createProject,
	createSignedInUser,
	createStudent,
	expectConnected,
	newTerminal,
	projectIds,
	query,
	seedFile,
	terminalIds,
	WEB_ORIGIN,
	workspacePath,
	workTabs,
} from "./helpers";
import { FAKE_AGENT_URL } from "./ports";

/**
 * The terminal draws on a WebGL canvas where the browser has one, so box and
 * block characters fill their cells, and falls back to xterm.js's DOM renderer
 * where it does not or when the context is lost (SPEC.md §9.1). This spec runs
 * with WebGL on; the other terminal specs run with it off because they read
 * text from the DOM renderer's rows (playwright.config.ts).
 */

const BOX = [
	"┌──────┐ ╔══════╗",
	"│      │ ║      ║",
	"│      │ ║      ║",
	"│      │ ║      ║",
	"│      │ ║      ║",
	"└──────┘ ╚══════╝",
];

interface Size {
	cols: number;
	rows: number;
}

/** Every resize frame the page sends, newest last. */
function recordSizes(page: Page): Size[] {
	const sizes: Size[] = [];
	page.on("websocket", (socket) => {
		socket.on("framesent", ({ payload }) => {
			if (typeof payload !== "string" || !payload.includes('"resize"')) return;
			sizes.push(JSON.parse(payload) as Size);
		});
	});
	return sizes;
}

function pane(page: Page, id: string): Locator {
	return page.getByTestId(`terminal-pane-${id}`);
}

/** The canvas xterm.js's WebGL renderer draws on, if it is in use. */
async function webglCanvasCount(page: Page, id: string): Promise<number> {
	return canvasesIn(pane(page, id));
}

/** The same count for any terminal, given the element it is in. */
async function canvasesIn(terminal: Locator): Promise<number> {
	return terminal.locator(".xterm-screen canvas").evaluateAll((canvases) => {
		let count = 0;
		for (const canvas of canvases as HTMLCanvasElement[]) {
			// A canvas that already has a 2D context answers null here.
			if (canvas.getContext("webgl2") || canvas.getContext("webgl")) count += 1;
		}
		return count;
	});
}

async function browserHasWebgl(page: Page): Promise<boolean> {
	return page.evaluate(
		() => document.createElement("canvas").getContext("webgl2") !== null,
	);
}

async function printLines(terminalId: string, lines: string[]): Promise<void> {
	const response = await fetch(
		`${FAKE_AGENT_URL}/__test/terminals/${terminalId}/output`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ lines }),
		},
	);
	if (!response.ok) throw new Error(`could not print lines: ${response.status}`);
}

async function openTerminal(
	page: Page,
	workspaceId: string,
): Promise<{ id: string; projectId: string }> {
	const project = await createProject(workspaceId, { name: "WebGL" });
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.goto(workspacePath(workspaceId, project.id));
	await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
	await newTerminal(page);
	await expect.poll(async () => (await terminalIds(workspaceId)).length).toBe(1);
	const [id] = await terminalIds(workspaceId);
	if (!id) throw new Error("the terminal row was not created");
	await expectConnected(page, id);
	await expect(pane(page, id).locator(".xterm-screen")).toBeVisible();
	return { id, projectId: project.id };
}

/**
 * How much of the box's strokes are inked, read from a screenshot of the
 * terminal screen: the share of the vertical stroke between the first and
 * last row's centres, and of the top edge between its corners. Gaps between
 * rows or cells show as background and bring the share below 1.
 */
async function boxCoverage(
	page: Page,
	id: string,
	size: Size,
): Promise<{ vertical: number; horizontal: number; background: string }> {
	const screen = pane(page, id).locator(".xterm-screen");
	const shot = await screen.screenshot();
	return page.evaluate(
		async ({ png, cols, rows }) => {
			const bitmap = await createImageBitmap(
				new Blob([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))]),
			);
			const canvas = document.createElement("canvas");
			canvas.width = bitmap.width;
			canvas.height = bitmap.height;
			const ctx = canvas.getContext("2d");
			if (!ctx) throw new Error("no 2d context");
			ctx.drawImage(bitmap, 0, 0);
			const cellW = bitmap.width / cols;
			const cellH = bitmap.height / rows;
			const pixel = (x: number, y: number) =>
				ctx.getImageData(Math.floor(x), Math.floor(y), 1, 1).data;
			// Empty cells well below the box give the background.
			const bg = pixel(cellW * 3.5, cellH * 10.5);
			const inked = (x: number, y: number) => {
				const p = pixel(x, y);
				return (
					Math.abs(p[0] - bg[0]) + Math.abs(p[1] - bg[1]) + Math.abs(p[2] - bg[2]) > 90
				);
			};
			// The vertical stroke is at the middle of column 0; take the best of
			// three pixel columns in case it is drawn off-centre.
			let vertical = 0;
			const top = Math.ceil(cellH * 0.55);
			const bottom = Math.floor(cellH * 5.45);
			for (const dx of [-1, 0, 1]) {
				let hit = 0;
				for (let y = top; y <= bottom; y += 1) {
					if (inked(Math.floor(cellW / 2) + dx, y)) hit += 1;
				}
				vertical = Math.max(vertical, hit / (bottom - top + 1));
			}
			// The top edge runs from column 1 to column 6 at the row's middle.
			let horizontal = 0;
			for (const dy of [-1, 0, 1]) {
				let hit = 0;
				const left = Math.ceil(cellW * 1.1);
				const right = Math.floor(cellW * 6.9);
				for (let x = left; x <= right; x += 1) {
					if (inked(x, Math.floor(cellH / 2) + dy)) hit += 1;
				}
				horizontal = Math.max(horizontal, hit / (right - left + 1));
			}
			return { vertical, horizontal, background: `${bg[0]},${bg[1]},${bg[2]}` };
		},
		{
			png: shot.toString("base64"),
			cols: size.cols,
			rows: size.rows,
		},
	);
}

async function lastSize(sizes: Size[]): Promise<Size> {
	await expect.poll(() => sizes.length).toBeGreaterThan(0);
	const size = sizes.at(-1);
	if (!size) throw new Error("no size sent");
	return size;
}

test("box-drawing characters fill their cells on the WebGL canvas", async ({
	page,
	context,
}) => {
	const sizes = recordSizes(page);
	const student = await createStudent(context);
	const { id } = await openTerminal(page, student.workspaceId);
	await printLines(id, BOX);

	if (!(await browserHasWebgl(page))) {
		// A browser without WebGL keeps the DOM renderer, and the text is there.
		await expect(pane(page, id).locator(".xterm-rows")).toContainText("┌──────┐");
		return;
	}

	await expect.poll(() => webglCanvasCount(page, id)).toBe(1);
	// The DOM renderer's rows are gone while the canvas draws.
	await expect(pane(page, id).locator(".xterm-rows")).toHaveCount(0);
	await expect
		.poll(async () => (await boxCoverage(page, id, await lastSize(sizes))).vertical, {
			timeout: 10_000,
		})
		.toBeGreaterThan(0.99);
	const coverage = await boxCoverage(page, id, await lastSize(sizes));
	expect(coverage.horizontal).toBeGreaterThan(0.99);
	// Dark background, #171614.
	expect(coverage.background).toBe("23,22,20");
});

test("a terminal's own theme, zoom and size still apply on the canvas", async ({
	page,
	context,
}) => {
	const sizes = recordSizes(page);
	const student = await createStudent(context);
	const { id } = await openTerminal(page, student.workspaceId);
	test.skip(!(await browserHasWebgl(page)), "this browser has no WebGL");
	await printLines(id, BOX);
	await expect.poll(() => webglCanvasCount(page, id)).toBe(1);
	await expect
		.poll(async () => (await boxCoverage(page, id, await lastSize(sizes))).vertical)
		.toBeGreaterThan(0.99);

	// Theme: this terminal alone turns light, and the box is inked on it.
	await page.getByTestId(`terminal-actions-${id}`).click();
	await page.getByTestId("terminal-theme-toggle").click();
	await expect
		.poll(async () => (await boxCoverage(page, id, await lastSize(sizes))).background)
		.toBe("253,252,250");
	expect((await boxCoverage(page, id, await lastSize(sizes))).vertical).toBeGreaterThan(
		0.99,
	);

	// Zoom: bigger cells make a narrower grid, and the box stays whole.
	const before = (await lastSize(sizes)).cols;
	const target = pane(page, id);
	const area = await target.boundingBox();
	if (!area) throw new Error("the pane has no box");
	await page.mouse.move(area.x + area.width / 2, area.y + area.height / 2);
	await page.keyboard.down("Control");
	await page.mouse.wheel(0, -100);
	await page.mouse.wheel(0, -100);
	await page.keyboard.up("Control");
	await expect(page.getByTestId(`pane-zoom-${id}`)).toHaveText("120%");
	await expect.poll(async () => (await lastSize(sizes)).cols).toBeLessThan(before);
	await expect
		.poll(async () => (await boxCoverage(page, id, await lastSize(sizes))).vertical)
		.toBeGreaterThan(0.99);

	// Resize: a narrower window fits the canvas to fewer columns.
	const zoomed = (await lastSize(sizes)).cols;
	await page.setViewportSize({ width: 1000, height: 800 });
	await expect.poll(async () => (await lastSize(sizes)).cols).toBeLessThan(zoomed);
	await expect
		.poll(async () => (await boxCoverage(page, id, await lastSize(sizes))).vertical)
		.toBeGreaterThan(0.99);
	expect(await webglCanvasCount(page, id)).toBe(1);
});

test("a link in the output is found and opened on the canvas", async ({
	page,
	context,
}) => {
	const sizes = recordSizes(page);
	const student = await createStudent(context);
	const { id } = await openTerminal(page, student.workspaceId);
	test.skip(!(await browserHasWebgl(page)), "this browser has no WebGL");
	await expect.poll(() => webglCanvasCount(page, id)).toBe(1);
	const url = "http://localhost:3000/x";
	await printLines(id, [url]);

	const size = await lastSize(sizes);
	const screen = pane(page, id).locator(".xterm-screen");
	const box = await screen.boundingBox();
	if (!box) throw new Error("the screen has no box");
	const cellW = box.width / size.cols;
	const cellH = box.height / size.rows;
	// A fresh terminal prints the line on its first row. The pointer has to
	// rest on the link before xterm.js treats a click as following it.
	const x = box.x + cellW * 8.5;
	const y = box.y + cellH * 0.5;
	await page.mouse.move(x, y);
	await page.mouse.move(x + 1, y);
	await page.mouse.click(x + 1, y);
	const [projectId] = await projectIds(student.workspaceId);
	await expect(page).toHaveURL(
		`/workspaces/${student.workspaceId}/projects/${projectId}?preview=3000`,
	);
});

test("a lost context drops to the DOM renderer and the terminal keeps working", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const { id } = await openTerminal(page, student.workspaceId);
	test.skip(!(await browserHasWebgl(page)), "this browser has no WebGL");
	await expect.poll(() => webglCanvasCount(page, id)).toBe(1);

	await page.evaluate(() => {
		for (const canvas of document.querySelectorAll<HTMLCanvasElement>(
			".xterm-screen canvas",
		)) {
			canvas.getContext("webgl2")?.getExtension("WEBGL_lose_context")?.loseContext();
		}
	});

	// xterm.js waits a few seconds for a restore before it reports the loss.
	await expect.poll(() => webglCanvasCount(page, id), { timeout: 20_000 }).toBe(0);
	await printLines(id, ["after-the-loss"]);
	await expect(pane(page, id).locator(".xterm-rows")).toContainText("after-the-loss");
});

test("when the browser's context cap drops the oldest, that terminal keeps working", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const { id } = await openTerminal(page, student.workspaceId);
	test.skip(!(await browserHasWebgl(page)), "this browser has no WebGL");
	await expect.poll(() => webglCanvasCount(page, id)).toBe(1);

	// Chrome keeps about sixteen live contexts and drops the oldest for the
	// next, which is how a student's many panes end up. The terminal's context
	// is the oldest here.
	await page.evaluate(() => {
		// Held on window so the contexts are not collected.
		const held: unknown[] = [];
		(window as unknown as { held: unknown[] }).held = held;
		for (let i = 0; i < 24; i += 1) {
			held.push(document.createElement("canvas").getContext("webgl2"));
		}
	});

	await expect.poll(() => webglCanvasCount(page, id), { timeout: 20_000 }).toBe(0);
	await printLines(id, ["after-the-cap"]);
	await expect(pane(page, id).locator(".xterm-rows")).toContainText("after-the-cap");
});

test("a browser with no WebGL shows the terminal on the DOM renderer", async ({
	page,
	context,
}) => {
	await page.addInitScript(() => {
		const original = HTMLCanvasElement.prototype.getContext;
		HTMLCanvasElement.prototype.getContext = function (
			this: HTMLCanvasElement,
			type: string,
			...rest: unknown[]
		) {
			if (type === "webgl2" || type === "webgl") return null;
			return (original as (...args: unknown[]) => unknown).call(this, type, ...rest);
		} as typeof original;
	});
	const student = await createStudent(context);
	const { id } = await openTerminal(page, student.workspaceId);
	await printLines(id, BOX);
	await expect(pane(page, id).locator(".xterm-rows")).toContainText("┌──────┐");
	expect(await webglCanvasCount(page, id)).toBe(0);
});

test("the wheel over a full-screen program counts rows from the canvas's cells", async ({
	page,
	context,
}) => {
	const sizes = recordSizes(page);
	const student = await createStudent(context);
	const { id } = await openTerminal(page, student.workspaceId);
	test.skip(!(await browserHasWebgl(page)), "this browser has no WebGL");
	await expect.poll(() => webglCanvasCount(page, id)).toBe(1);
	const size = await lastSize(sizes);
	const screen = pane(page, id).locator(".xterm-screen");
	const box = await screen.boundingBox();
	if (!box) throw new Error("the screen has no box");
	const cellH = box.height / size.rows;

	const alternate = await fetch(`${FAKE_AGENT_URL}/__test/terminals/${id}/screen`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ alternate: true }),
	});
	expect(alternate.ok).toBe(true);
	const arrows = async (): Promise<number> => {
		const response = await fetch(`${FAKE_AGENT_URL}/__test/received`);
		const body = (await response.json()) as {
			received: { terminalId: string; text: string }[];
		};
		return (
			body.received
				.filter((frame) => frame.terminalId === id)
				.map((frame) => frame.text)
				.join("")
				.split("\\u001b[A").length - 1
		);
	};
	const before = await arrows();
	await screen.hover();
	// Ten rows' worth of pixels is ten arrow keys when the row height is the
	// cell height, and eleven if a fixed guess stood in for it.
	await page.mouse.wheel(0, -Math.round(cellH * 10));
	await expect.poll(async () => (await arrows()) - before).toBe(10);
});

/**
 * The longest unbroken run of ink in one pixel column of a terminal screen,
 * in pixels. A letter is about one row tall; a box side drawn to fill its
 * cells runs through every row of the box, while rows with gaps between them
 * (the DOM renderer at a line height above 1) never exceed a row.
 */
async function longestInkRun(screen: Locator): Promise<number> {
	const shot = await screen.screenshot();
	return screen.page().evaluate(async (png) => {
		const bitmap = await createImageBitmap(
			new Blob([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))]),
		);
		const canvas = document.createElement("canvas");
		canvas.width = bitmap.width;
		canvas.height = bitmap.height;
		const ctx = canvas.getContext("2d");
		if (!ctx) throw new Error("no 2d context");
		ctx.drawImage(bitmap, 0, 0);
		const { data, width, height } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
		// The bottom-right corner is empty: the text starts at the top left.
		const at = (x: number, y: number) => (y * width + x) * 4;
		const corner = at(width - 3, height - 3);
		const bg = [data[corner] ?? 0, data[corner + 1] ?? 0, data[corner + 2] ?? 0];
		let longest = 0;
		for (let x = 0; x < width; x += 1) {
			let run = 0;
			for (let y = 0; y < height; y += 1) {
				const i = at(x, y);
				const distance =
					Math.abs((data[i] ?? 0) - (bg[0] ?? 0)) +
					Math.abs((data[i + 1] ?? 0) - (bg[1] ?? 0)) +
					Math.abs((data[i + 2] ?? 0) - (bg[2] ?? 0));
				run = distance > 90 ? run + 1 : 0;
				if (run > longest) longest = run;
			}
		}
		return longest;
	}, shot.toString("base64"));
}

/** Four rows at the smallest type any of these terminals use (13 px). */
const SEAMLESS_RUN = 4 * 13;

test("the live-help helper view draws the student's box on a canvas", async ({
	page,
	context,
	browser,
}) => {
	test.skip(!(await browserHasWebgl(page)), "this browser has no WebGL");
	const student = await createStudent(context);
	await query("update users set display_name = 'Ada Student' where id = $1", [
		student.userId,
	]);
	const project = await createProject(student.workspaceId, { name: "Live Box" });
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.goto(workspacePath(student.workspaceId, project.id));
	await newTerminal(page);
	await expect
		.poll(async () => (await terminalIds(student.workspaceId)).length)
		.toBe(1);
	const [terminalId] = await terminalIds(student.workspaceId);
	if (!terminalId) throw new Error("the terminal row was not created");
	await expectConnected(page, terminalId);

	const instructorContext = await browser.newContext({ baseURL: WEB_ORIGIN });
	try {
		const instructor = await createSignedInUser(instructorContext, "student");
		const [course] = await query<{ id: string }>(
			`insert into lti_contexts (platform_issuer, context_id, title, platform_name)
			 values ('e2e-live-help', $1, $2, 'E2E LMS') returning id`,
			[`box-${instructor.userId.slice(0, 8)}`, "Box course"],
		);
		if (!course) throw new Error("could not create the course");
		await query(
			`insert into lti_memberships (context_id, user_id, role, last_launch_at)
			 values ($1, $2, 'instructor', now()), ($1, $3, 'student', now())`,
			[course.id, instructor.userId, student.userId],
		);
		const started = await page.request.post(
			`/workspaces/${student.workspaceId}/projects/${project.id}/live-help`,
			{
				headers: { origin: WEB_ORIGIN },
				data: { helperUserId: instructor.userId, courseId: course.id },
			},
		);
		expect(started.status()).toBe(200);

		const helperPage = await instructorContext.newPage();
		await helperPage.setViewportSize({ width: 1280, height: 800 });
		await helperPage.goto(`/course/${course.id}`);
		await helperPage.getByTestId("course-live-help").click();
		await helperPage
			.getByRole("link", { name: "Open live help with Ada Student on Live Box" })
			.click();
		const helper = helperPage.getByTestId("helper-terminal");
		await expect(helper).toHaveAttribute("data-connected", "true", {
			timeout: 15_000,
		});

		await printLines(terminalId, BOX);
		await expect.poll(() => canvasesIn(helper)).toBe(1);
		await expect(helper.locator(".xterm-rows")).toHaveCount(0);
		await expect
			.poll(() => longestInkRun(helper.locator(".xterm-screen")), { timeout: 10_000 })
			.toBeGreaterThan(SEAMLESS_RUN);
	} finally {
		await instructorContext.close();
	}
});

test("a check's output draws box characters on a canvas", async ({ page, context }) => {
	test.skip(!(await browserHasWebgl(page)), "this browser has no WebGL");
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "Check Box" });
	// The fake agent prints the command and then its own result lines, so the
	// box rides in the command, one row per line.
	await seedFile(
		student.workspaceId,
		project.slug,
		".portikus/checks.json",
		JSON.stringify({
			checks: [{ id: "box", name: "Box", command: `box\r\n${BOX.join("\r\n")}` }],
		}),
	);
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.goto(workspacePath(student.workspaceId, project.id));
	await expect(page.getByTestId("right-pane-tab-checks")).toBeVisible({
		timeout: 15_000,
	});
	await page.getByTestId("right-pane-tab-checks").click();
	await page.getByTestId("check-run-box").click();

	const output = page.getByTestId("check-output-box");
	await expect(output).toBeVisible({ timeout: 15_000 });
	await expect.poll(() => canvasesIn(output)).toBe(1);
	await expect(output.locator(".xterm-rows")).toHaveCount(0);
	await expect(page.getByTestId("check-state-box")).toContainText("Passed", {
		timeout: 15_000,
	});
	await expect
		.poll(() => longestInkRun(output.locator(".xterm-screen")), { timeout: 10_000 })
		.toBeGreaterThan(SEAMLESS_RUN);
});
