import { deflateSync } from "node:zlib";
import { expect, type Page, test, type WebSocketRoute } from "@playwright/test";
import {
	createProject,
	createStudent,
	expectNoViolations,
	newTerminal,
	query,
	terminalIds,
	workspacePath,
	workTabs,
} from "./helpers";

/**
 * The chat tab's conversation and cards (SPEC.md §8.3, §10.8, §25.8). The
 * page's chat socket is answered by a script in the test, so each frame
 * and each answer is exact; the fake agent's chat covers the API relay.
 */

/** A solid PNG, so the tool's image is a real one. */
function png(width: number, height: number): string {
	const crcTable = Array.from({ length: 256 }, (_, n) => {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		return c >>> 0;
	});
	const crc = (buf: Buffer) => {
		let c = 0xffffffff;
		for (const byte of buf) c = (crcTable[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
		return (c ^ 0xffffffff) >>> 0;
	};
	const chunk = (type: string, data: Buffer) => {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(data.length);
		const body = Buffer.concat([Buffer.from(type), data]);
		const sum = Buffer.alloc(4);
		sum.writeUInt32BE(crc(body));
		return Buffer.concat([len, body, sum]);
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header.set([8, 2, 0, 0, 0], 8);
	const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x5a)]);
	const raw = Buffer.concat(Array.from({ length: height }, () => row));
	return Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(raw)),
		chunk("IEND", Buffer.alloc(0)),
	]).toString("base64");
}

const QUESTION = {
	id: "q1",
	questions: [
		{
			question: "Which layout should the dashboard use?",
			header: "Layout",
			multiSelect: false,
			options: [
				{
					label: "Grid",
					description: "Cards in rows and columns",
					preview: "+--------+--------+\n| Builds | Tests  |\n+--------+--------+",
				},
				{
					label: "Stack",
					description: "One column, newest first",
					preview:
						"+-----------------+\n| Builds          |\n| Tests           |\n+-----------------+",
				},
			],
		},
		{
			question: "Which checks should run on save?",
			header: "Checks",
			multiSelect: true,
			options: [
				{ label: "Lint", description: "Biome" },
				{ label: "Types", description: "tsc --noEmit" },
				{ label: "Tests", description: "Only the changed files" },
			],
		},
	],
};

const PERMISSION = {
	id: "p1",
	toolName: "Bash",
	title: "Run the unit tests",
	input: { command: "pnpm vitest run src/dashboard", timeout: 120000 },
	options: [
		{ id: "allow", label: "Allow" },
		{ id: "always", label: "Allow for this session" },
		{ id: "deny", label: "Deny" },
	],
};

/** Plays a short turn, then the cards, answering as the fake chat will. */
function script(ws: WebSocketRoute, answers: unknown[]) {
	let seq = 0;
	const session = "00000000-0000-4000-8000-000000000000";
	const send = (type: string, body: Record<string, unknown> = {}) =>
		ws.send(JSON.stringify({ type, sessionId: session, seq: seq++, ...body }));
	send("snapshot", {
		messages: [
			{
				id: "u1",
				role: "user",
				markdown: "Make the dashboard load faster and show me what changed.",
			},
		],
		cards: [],
		turnRunning: false,
		truncated: true,
	});
	send("turn.started");
	send("text.delta", {
		messageId: "a1",
		text: "I'll start by profiling the **dashboard** route. ",
	});
	send("text.delta", {
		messageId: "a1",
		text: "![tracking](https://remote-image.example/leak.png?q=secret)",
	});
	send("message", {
		id: "a1",
		role: "assistant",
		markdown:
			"I'll start by profiling the **dashboard** route. ![tracking](https://remote-image.example/leak.png?q=secret)",
	});
	send("tool.started", {
		id: "t1",
		name: "Screenshot",
		title: "http://localhost:5173/dashboard",
		input: { url: "http://localhost:5173/dashboard", fullPage: false },
	});
	send("tool.output", {
		id: "t1",
		part: { type: "text", text: "Saved 320x180 screenshot" },
	});
	send("tool.output", {
		id: "t1",
		part: { type: "image", mediaType: "image/png", data: png(320, 180) },
	});
	send("tool.output", {
		id: "t1",
		part: { type: "imageOmitted", mediaType: "image/png" },
	});
	send("tool.finished", { id: "t1", isError: false });
	send("tool.started", {
		id: "t2",
		name: "Bash",
		title:
			"grep -R useDashboardQuery src/averyveryveryverylongunbrokenpathsegmentthatkeepsgoing",
		input: { command: "grep -R useDashboardQuery src" },
	});
	send("tool.output", {
		id: "t2",
		part: { type: "text", text: "grep: src/missing: No such file or directory" },
	});
	send("tool.finished", { id: "t2", isError: true });
	send("message", {
		id: "a2",
		role: "assistant",
		markdown: "The query runs twice on mount.",
	});
	send("message", {
		id: "a3",
		role: "assistant",
		markdown:
			"Done. The dashboard now loads its data **once**.\n\n- Removed the duplicate query\n- Added a test\n\n```ts\nconst data = useDashboardQuery();\n```\n\nSee [the React docs](https://react.dev/reference/react/useEffect).",
	});
	send("turn.finished", { status: "done" });
	send("question.requested", QUESTION);
	ws.onMessage((raw) => {
		const message = JSON.parse(String(raw));
		answers.push(message);
		if (message.type === "question.answer") {
			send("card.resolved", { id: "q1" });
			send("permission.requested", PERMISSION);
		}
		if (message.type === "permission.answer") send("card.resolved", { id: "p1" });
	});
}

async function openChat(page: Page, context: Parameters<typeof createStudent>[0]) {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "Dashboard" });
	await page.goto(workspacePath(student.workspaceId, project.id));
	await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
	await newTerminal(page);
	await expect
		.poll(async () => (await terminalIds(student.workspaceId, project.id)).length)
		.toBe(1);
	const [id] = await terminalIds(student.workspaceId, project.id);
	await query(
		"update terminals set kind = 'chat', agent = 'claude', name = 'Claude Code' where id = $1",
		[id],
	);
	const answers: unknown[] = [];
	await page.routeWebSocket(/\/chat$/, (ws) => script(ws, answers));
	const remote: string[] = [];
	page.on("request", (request) => {
		if (request.url().includes("remote-image.example")) remote.push(request.url());
	});
	await page.reload();
	await expect(page.getByTestId(`chat-view-${id}`)).toBeVisible({ timeout: 15_000 });
	return { id: id as string, answers, remote };
}

for (const colorScheme of ["light", "dark"] as const) {
	for (const width of [1440, 360] as const) {
		test(`scripted chat (${colorScheme}, ${width})`, async ({ page, context }) => {
			test.setTimeout(90_000);
			await page.emulateMedia({ colorScheme });
			await page.setViewportSize({ width, height: 900 });
			const { id, answers, remote } = await openChat(page, context);
			const view = page.getByTestId(`chat-view-${id}`);
			await expect(
				view.getByText("Done. The dashboard now loads its data"),
			).toBeVisible();
			// The card takes the keyboard as it arrives.
			await expect(view.getByRole("radio", { name: "Grid" })).toBeFocused();
			await expect(view.getByTestId("chat-worked").locator("> summary")).toBeVisible();
			await view.getByTestId("chat-worked").locator("> summary").click();
			await view.getByTestId("chat-tool-t1").locator("summary").click();
			await expect(
				view.getByRole("img", { name: "Output of Screenshot" }),
			).toBeVisible();
			await expect(view.getByTestId("chat-question-card")).toBeVisible();
			await view.getByTestId("chat-tool-t2").locator("summary").click();
			await view.locator(".pk-chat-scroll").evaluate((box) => box.scrollTo(0, 0));
			await expectNoViolations(page, `[data-testid="chat-view-${id}"]`);

			// Keyboard only from here, starting where the card put the focus.
			await view.getByRole("radio", { name: "Grid" }).focus();
			await page.keyboard.press("ArrowDown");
			await expect(view.getByTestId("chat-question-preview").first()).toContainText(
				"Tests           |",
			);
			await page.keyboard.press("Tab"); // Other text
			await page.keyboard.press("Tab"); // preview
			await page.keyboard.press("Tab"); // notes
			await page.keyboard.type("Keep it simple");
			await page.keyboard.press("Tab"); // first checkbox
			await page.keyboard.press("Space");
			await page.keyboard.press("Tab");
			await page.keyboard.press("Tab");
			await page.keyboard.press("Space");
			await page.keyboard.press("Tab"); // Other
			await page.keyboard.type("and a build");
			await page.keyboard.press("Enter");
			await expect(view.getByTestId("chat-question-card")).toHaveCount(0);
			await expect(view.getByTestId("chat-permission-card")).toBeVisible();
			await expect(
				view.getByRole("button", { name: "Allow", exact: true }),
			).toBeFocused();
			await expectNoViolations(page, `[data-testid="chat-view-${id}"]`);
			await page.keyboard.press("Enter");
			await expect(view.getByTestId("chat-permission-card")).toHaveCount(0);
			expect(answers).toEqual([
				{
					type: "question.answer",
					id: "q1",
					answers: {
						"Which layout should the dashboard use?": "Stack",
						"Which checks should run on save?": "Lint, Tests",
					},
					notes: {
						"Which layout should the dashboard use?": "Keep it simple",
						"Which checks should run on save?": "and a build",
					},
				},
				{ type: "permission.answer", id: "p1", optionId: "allow" },
			]);
			expect(remote).toEqual([]);
			const overflow = await view.evaluate(
				(node) => node.scrollWidth - node.clientWidth,
			);
			expect(overflow).toBe(0);
		});
	}
}
