import { expect, type Page, test } from "@playwright/test";
import { makeChatTab, openChat, scriptedChat } from "./chat-helpers";
import { createStudent, expectNoViolations } from "./helpers";

/**
 * A `!` shell command in the conversation (SPEC.md §10.8, §25.8): the command
 * as a command and its output as output, plainly not a reply from Claude, with
 * the state said in words in both themes. The host is a script that sends the
 * `shell` events.
 */

type Send = (type: string, body?: Record<string, unknown>) => void;

const LS = {
	id: "sh-ls",
	command: "ls -la",
	output: "total 8\ndrwxr-xr-x 2 student student 4096 index.html\n",
	exitCode: 0,
	truncated: false,
	state: "done",
};

const FAILED = {
	id: "sh-fail",
	command: "cat missing.txt",
	output: "cat: missing.txt: No such file or directory\n",
	exitCode: 1,
	truncated: false,
	state: "done",
};

/** A chat whose host replays `first` on every attach and hands back its `send`. */
async function openScriptedChat(page: Page, id: string, first: [string, object][]) {
	let post: Send | undefined;
	await page.routeWebSocket(/\/chat$/, (ws) => {
		const send = scriptedChat(ws, id);
		post = send;
		send("snapshot", { cards: [], turnRunning: false, truncated: false });
		send("settings", {
			agent: "claude",
			model: "default",
			effort: "high",
			mode: "default",
		});
		for (const [type, body] of first) send(type, { ...body });
	});
	await page.reload();
	const view = page.getByTestId(`chat-view-${id}`);
	await expect(view.getByTestId("composer-model")).toBeVisible({ timeout: 15_000 });
	return {
		view,
		send: ((type, body) => {
			if (!post) throw new Error("the chat socket is not open");
			post(type, body);
		}) as Send,
	};
}

for (const colorScheme of ["light", "dark"] as const) {
	for (const width of [1280, 420] as const) {
		test(`a shell command shows as a command with its output and state (${colorScheme}, ${width})`, async ({
			page,
			context,
		}) => {
			test.setTimeout(90_000);
			await page.emulateMedia({ colorScheme });
			await page.setViewportSize({ width, height: 900 });
			const { id } = await makeChatTab(page, context);
			const { view, send } = await openScriptedChat(page, id, [
				["message", { id: "u1", role: "user", markdown: "Hello" }],
				["shell", LS],
				["shell", { ...FAILED, truncated: true }],
				[
					"shell",
					{
						id: "sh-run",
						command: "sleep 30",
						output: "",
						exitCode: null,
						truncated: false,
						state: "running",
					},
				],
			]);
			const shells = view.getByTestId("chat-shell");
			await expect(shells).toHaveCount(3);

			// The command is a command: a $ marker, monospace, and not in a Claude turn.
			const first = shells.nth(0);
			await expect(first.getByRole("group", { name: "Shell command" })).toBeVisible();
			await expect(first.getByTestId("chat-shell-command")).toHaveText("$ls -la");
			await expect(first.getByTestId("chat-shell-command")).toHaveCSS(
				"font-family",
				/mono|Mono|monospace/,
			);
			await expect(first.getByTestId("chat-shell-output")).toHaveText(
				/total 8\ndrwxr-xr-x/,
			);
			await expect(first.getByTestId("chat-shell-output")).toHaveCSS(
				"white-space",
				"pre",
			);
			await expect(view.getByTestId("chat-turn")).toHaveCount(0);
			await expect(first.getByText("Claude", { exact: true })).toHaveCount(0);

			// A failure and a cut-short output say so in words.
			const second = shells.nth(1);
			await expect(second.getByTestId("chat-shell-status")).toHaveText(
				"Failed with exit code 1",
			);
			await expect(second.getByTestId("chat-shell-truncated")).toHaveText(
				"Output truncated",
			);
			await expect(shells.nth(2).getByTestId("chat-shell-status")).toHaveText(
				"Running",
			);
			await expectNoViolations(page, `[data-testid="chat-view-${id}"]`);

			// The same command finishes in place, with its output.
			send("shell", {
				id: "sh-run",
				command: "sleep 30",
				output: "woke up\n",
				exitCode: 0,
				truncated: false,
				state: "done",
			});
			await expect(shells).toHaveCount(3);
			await expect(shells.nth(2).getByTestId("chat-shell-output")).toHaveText(
				"woke up",
			);
			await expect(shells.nth(2).getByTestId("chat-shell-status")).toHaveText(
				"Finished with exit code 0",
			);
			await expectNoViolations(page, `[data-testid="chat-view-${id}"]`);

			// The conversation never scrolls sideways.
			const overflow = await page.evaluate(() => {
				const log = document.querySelector<HTMLElement>(".pk-chat-scroll");
				return log ? log.scrollWidth - log.clientWidth : -1;
			});
			expect(overflow).toBeLessThanOrEqual(0);
		});
	}
}

test("a long output scrolls inside its box, which the keyboard reaches", async ({
	page,
	context,
}) => {
	test.setTimeout(60_000);
	const { id } = await makeChatTab(page, context);
	const output = Array.from({ length: 200 }, (_, at) => `line ${at}`).join("\n");
	const { view } = await openScriptedChat(page, id, [
		["shell", { ...LS, id: "sh-long", command: "seq 200", output }],
		["message", { id: "a1", role: "assistant", markdown: "After the command" }],
	]);
	const box = view.getByTestId("chat-shell-output");
	await expect(box).toBeVisible();
	const sizes = await box.evaluate((node) => ({
		client: node.clientHeight,
		scroll: node.scrollHeight,
	}));
	expect(sizes.scroll).toBeGreaterThan(sizes.client);
	expect(sizes.client).toBeLessThan(400);
	await box.focus();
	await expect(box).toBeFocused();
	await page.keyboard.press("PageDown");
	await expect.poll(() => box.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
	// Claude's reply after it is still there, below, with its own byline.
	await expect(view.getByTestId("chat-assistant-message")).toHaveText(
		"After the command",
	);
});

test("a reload replays the commands in order, each once", async ({ page, context }) => {
	test.setTimeout(60_000);
	const { id } = await makeChatTab(page, context);
	const first: [string, object][] = [
		["shell", { ...LS, id: "sh-ls", state: "running", exitCode: null, output: "" }],
		["shell", LS],
		["shell", FAILED],
	];
	const { view } = await openScriptedChat(page, id, first);
	const commands = view.getByTestId("chat-shell-command");
	await expect(commands).toHaveText(["$ls -la", "$cat missing.txt"]);
	await page.reload();
	await expect(view.getByTestId("chat-shell")).toHaveCount(2);
});

test("a `!` sent from the composer runs as a command, starts no turn, and survives a reload", async ({
	page,
	context,
}) => {
	test.setTimeout(90_000);
	const student = await createStudent(context);
	const { view } = await openChat(page, student.workspaceId, "Shell send");
	// The fake host's earlier turn is the only turn before the command.
	await expect(view.getByText("Earlier answer")).toBeVisible();
	const turns = view.getByTestId("chat-turn");
	await expect(turns).toHaveCount(1);
	const box = view.getByTestId("chat-composer-input");
	await box.fill("!ls -la");
	await box.press("Enter");
	const shells = view.getByTestId("chat-shell");
	await expect(shells).toHaveCount(1);
	await expect(shells.first().getByTestId("chat-shell-output")).toHaveText(
		"ran ls -la",
	);
	await expect(shells.first().getByTestId("chat-shell-status")).toHaveText(
		"Finished with exit code 0",
	);
	await expect(shells.first()).toContainText("ls -la");
	await expect(turns).toHaveCount(1);
	await expect(
		view.getByTestId("chat-user-message").filter({ hasText: "ls -la" }),
	).toHaveCount(0);

	await page.reload();
	await expect(view.getByTestId("chat-shell")).toHaveCount(1, { timeout: 15_000 });
	await expect(view.getByTestId("chat-shell-output")).toHaveText("ran ls -la");
});
