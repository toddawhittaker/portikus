import { expect, test } from "@playwright/test";
import { makeChatTab, scriptChat } from "./chat-helpers";
import { expectNoViolations } from "./helpers";

/**
 * A `!` command that is still running can be stopped from the box (SPEC.md
 * §10.8, §25.8): Stop appears beside Send while the chat holds a running
 * shell item, sends the same interrupt that stops a turn, and goes when the
 * host reports the command done. The host is a script, so the running state
 * lasts until the test ends it.
 */

const RUNNING = {
	id: "sh-dev",
	command: "npm run dev",
	output: "",
	exitCode: null,
	truncated: false,
	state: "running",
};

for (const colorScheme of ["light", "dark"] as const) {
	test(`Stop ends a running ! command, by button and by Escape (${colorScheme})`, async ({
		page,
		context,
	}) => {
		test.setTimeout(90_000);
		await page.emulateMedia({ colorScheme });
		const { id } = await makeChatTab(page, context);
		const interrupts: string[] = [];
		let finish: () => void = () => {};
		const view = await scriptChat(page, id, {
			first: [["shell", RUNNING]],
			reply: (message, send) => {
				if (message.type !== "interrupt") return;
				interrupts.push(message.type);
				// The host ends the command when the student tells the test to.
				finish = () =>
					send(["shell", { ...RUNNING, output: "^C\n", exitCode: 130, state: "done" }]);
			},
		});
		const stop = view.getByTestId("chat-composer-stop");
		await expect(stop).toBeVisible();
		await expect(stop).toHaveAccessibleName("Stop");
		await expect(view.getByTestId("chat-composer-hint")).toHaveText(
			"The command is running. Esc stops it.",
		);
		await expectNoViolations(page, '[data-testid="chat-composer"]');

		await stop.click();
		await expect.poll(() => interrupts.length).toBe(1);
		// The host answers by ending the command; only then does Stop go.
		await expect(stop).toBeVisible();
		finish();
		await expect(stop).toHaveCount(0);
		await expect(view.getByTestId("chat-shell-status")).toHaveText(
			"Failed with exit code 130",
		);
	});
}

test("Escape in the box stops a running ! command too", async ({ page, context }) => {
	test.setTimeout(90_000);
	const { id } = await makeChatTab(page, context);
	const interrupts: string[] = [];
	const view = await scriptChat(page, id, {
		first: [["shell", RUNNING]],
		reply: (message) => {
			if (message.type === "interrupt") interrupts.push(message.type);
		},
	});
	await expect(view.getByTestId("chat-composer-stop")).toBeVisible();
	const box = view.getByTestId("chat-composer-input");
	await box.click();
	await page.keyboard.press("Escape");
	await expect.poll(() => interrupts.length).toBe(1);
});
